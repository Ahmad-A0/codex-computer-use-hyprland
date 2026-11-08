#!/usr/bin/env bash
# Boot a disposable Arch Linux VM (official cloud image, QEMU/KVM), install
# Hyprland and this provider the way a user would, and run the end-to-end suite
# inside a real Hyprland session. Needs x86_64 Linux with KVM, qemu and one of
# cloud-localds, xorriso or genisoimage.
#   E2E_HYPRLAND     release (default): Arch's hyprland package. git: Hyprland's
#                    development branch (main of github.com/hyprwm/Hyprland) built
#                    from source in the guest over the package (hyprland-git.sh),
#                    an early warning before Arch ships a release
#   E2E_HYPRLAND_COMMIT  with git, the Hyprland commit to build (default: main's head)
#   E2E_CACHE        images (default ~/.cache/codex-hyprland-e2e): base/ holds
#                    the cloud image, ready/ the provisioned disk (one per
#                    E2E_HYPRLAND variant), rebuilt daily, when provisioning
#                    changes or, for git, for each new Hyprland commit. Tests run
#                    on a throwaway overlay. ccache/ holds git's compiler cache.
#   E2E_REPROVISION  set to rebuild the provisioned disk
#   E2E_VM_CPUS, E2E_VM_MEMORY  guest CPUs and MiB (default 2 and 4608; the git
#                    variant provisions with all host CPUs and spare memory)
#   E2E_ARTIFACTS    results, logs, versions.json, screenshot (default ./e2e-artifacts)
#   E2E_ONLY         passed through to the suite
#   E2E_INSTALL      checkout (default): ./install. plugin: `codex plugin add`, then
#                    the suite drives the plugin's cua_repl command
#   E2E_TIMEOUT      suite time limit in seconds (default 1500)
# --cache-keys prints ready=<provisioned disk key> and base=<cloud image key>.
# Keys: release <date>-<hash>, git git-<commit>-<date>-<hash>, where the hash
# covers the provisioning scripts, cloud image, latest chatgpt-bin and Arch
# hyprland and, for git, the Hyprland commit (which also pins the hyprwm
# library revisions built with it, through its flake.lock).
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
cache=${E2E_CACHE:-$HOME/.cache/codex-hyprland-e2e}
artifacts=${E2E_ARTIFACTS:-$PWD/e2e-artifacts}
image_url=https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
user=tester
repo=codex-computer-use-hyprland

# Latest chatgpt-bin and hyprland, so a new upstream release reprovisions.
upstream() {
  if [ -x "$root/scripts/release/upstream.sh" ]; then "$root/scripts/release/upstream.sh"; return; fi
  python3 - <<'EOF'
import io, json, tarfile, urllib.request
def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'codex-hyprland-e2e'}), timeout=30).read()
versions = {}
with tarfile.open(fileobj=io.BytesIO(get('https://persistent.oaistatic.com/codex-app-prod/linux/arch/x86_64/openai-chatgpt.db'))) as db:
    for member in db.getmembers():
        if member.name.endswith('/desc'):
            lines = db.extractfile(member).read().decode().split('\n')
            entry = {lines[i]: lines[i + 1] for i in range(len(lines) - 1) if lines[i].startswith('%')}
            if entry.get('%NAME%') == 'chatgpt-bin':
                versions['chatgpt-bin'] = entry['%VERSION%']
arch = json.loads(get('https://archlinux.org/packages/extra/x86_64/hyprland/json/'))
versions['hyprland'] = f"{arch['pkgver']}-{arch['pkgrel']}"
print(json.dumps(versions, sort_keys=True))
EOF
}
variant=${E2E_HYPRLAND:-release}
case $variant in
  release) commit= prefix= ;;
  git)
    commit=${E2E_HYPRLAND_COMMIT:-$(git ls-remote https://github.com/hyprwm/Hyprland refs/heads/main | cut -f 1)}
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "Hyprland main commit lookup failed: '$commit'" >&2; exit 1; }
    prefix=git-${commit:0:12}- ;;
  *) echo "E2E_HYPRLAND must be release or git, not '$variant'" >&2; exit 2 ;;
esac
sha=$(curl -fsSL --retry 3 "$image_url.SHA256" | cut -d ' ' -f 1)
key=$prefix$(date -u +%F)-$(cat "$here/provision.sh" "$here/hyprland.lua" "$here/openai-chatgpt.gpg" <(echo "$sha") <(upstream) \
  <(if [ -n "$commit" ]; then cat "$here/hyprland-git.sh"; echo "$commit"; fi) | sha256sum | cut -c 1-16)
if [ "${1:-}" = --cache-keys ]; then
  printf 'ready=%s\nbase=%s\n' "$key" "$sha"
  exit
fi
mkdir -p "$cache/base" "$cache/ready" "$artifacts"
artifacts=$(cd "$artifacts" && pwd); cache=$(cd "$cache" && pwd)
# Next to the images, not in /tmp: the overlay grows by gigabytes while
# provisioning, more than a tmpfs /tmp holds.
work=$(mktemp -d "$cache/work.XXXXXX")
: > "$artifacts/timings.txt"
started=$(date +%s)
mark() { echo "$1 $(( $(date +%s) - started ))s" | tee -a "$artifacts/timings.txt"; started=$(date +%s); }

ready="$cache/ready/provisioned-$key.qcow2"
# Older disks of this variant (release keys start with the date).
if [ "$variant" = git ]; then stale='provisioned-git-*.qcow2'; else stale='provisioned-[0-9]*.qcow2'; fi
vm_cpus=${E2E_VM_CPUS:-2} vm_memory=${E2E_VM_MEMORY:-4608}

ssh-keygen -q -t ed25519 -N '' -f "$work/key"
port=${E2E_SSH_PORT:-$((20000 + RANDOM % 20000))}
vm() {
  ssh -q -i "$work/key" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o ServerAliveInterval=15 "$user@127.0.0.1" "$@"
}
# Boot a fresh overlay of $1. Each boot is a new cloud-init instance, which
# authorizes this run's key for one passwordless-sudo user.
boot() {
  rm -f "$work/disk.qcow2" "$work/seed.iso"
  qemu-img create -q -f qcow2 -F qcow2 -b "$1" "$work/disk.qcow2" 16G
  cat > "$work/user-data" <<EOF
#cloud-config
users:
  - name: $user
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: ["$(cat "$work/key.pub")"]
EOF
  printf 'instance-id: codex-e2e-%s\nlocal-hostname: codex-e2e\n' "$(date +%s%N)" > "$work/meta-data"
  if command -v cloud-localds >/dev/null; then
    cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"
  elif command -v xorriso >/dev/null; then
    xorriso -as mkisofs -quiet -o "$work/seed.iso" -V cidata -J -r "$work/user-data" "$work/meta-data"
  else
    "$(command -v genisoimage || command -v mkisofs)" -quiet -o "$work/seed.iso" -V cidata -J -r "$work/user-data" "$work/meta-data"
  fi
  # virtio-gpu gives the guest a KMS device, as in Hyprland's own CI VM test.
  qemu-system-x86_64 -accel kvm -cpu host -smp "$vm_cpus" -m "$vm_memory" \
    -drive "if=virtio,file=$work/disk.qcow2,discard=unmap" \
    -drive "if=virtio,file=$work/seed.iso,format=raw,readonly=on" \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$port-:22" \
    -vga none -device virtio-gpu-pci,xres=1920,yres=1080 -display none -monitor none \
    -serial "file:$artifacts/console$2.log" -daemonize -pidfile "$work/qemu.pid"
  for _ in $(seq 120); do vm true 2>/dev/null && break; sleep 5; done
  vm 'sudo cloud-init status --wait >/dev/null; true'
}
halt() {
  local pid; pid=$(cat "$work/qemu.pid")
  vm 'sudo systemctl poweroff' 2>/dev/null || true
  for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  rm -f "$work/qemu.pid"
}
# Commands run like a terminal in the session: Hyprland's exported environment.
session() { vm ". ~/.session-env; cd ~/$repo && $*"; }
collect() {
  vm 'set +e; out=~/e2e-out; mkdir -p $out; . ~/.session-env 2>/dev/null
    grim "$out/screen.png"; cp ~/hyprland.out "$out/"
    cp "$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/hyprland.log" "$out/"
    sudo journalctl -b --no-pager > "$out/journal.txt"
    tar -C $out --exclude=./browser -cf - .' | tar -C "$artifacts" -xf - || true
}
cleanup() {
  status=$?
  [ -z "${testing:-}" ] || collect
  [ ! -f "$work/qemu.pid" ] || kill "$(cat "$work/qemu.pid")" 2>/dev/null || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

if [ -f "$ready" ] && [ -z "${E2E_REPROVISION:-}" ]; then
  echo "Using provisioned image $key"
else
  # Official cloud image, verified against the published checksum.
  base="$cache/base/arch-cloudimg-$sha.qcow2"
  if [ ! -f "$base" ]; then
    curl -fL --retry 3 -o "$base.part" "$image_url"
    echo "$sha  $base.part" | sha256sum -c --quiet
    rm -f "$cache"/base/*.qcow2
    mv "$base.part" "$base"
  fi
  mark base
  if [ "$variant" = git ]; then
    # Compiling Hyprland: every host CPU and the memory the host can spare.
    spare=$(( $(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo) - 2048 ))
    vm_cpus=${E2E_VM_CPUS:-$(nproc)}
    vm_memory=${E2E_VM_MEMORY:-$(( spare > 12288 ? 12288 : spare > 4608 ? spare : 4608 ))}
  fi
  boot "$base" -provision
  mark boot-provision
  tar -C "$here" -cf - provision.sh hyprland-git.sh hyprland.lua openai-chatgpt.gpg | vm 'mkdir -p ~/provision && tar -C ~/provision -xf -'
  if [ "$variant" = git ] && [ -d "$cache/ccache" ]; then
    tar -C "$cache/ccache" -cf - . | vm 'sudo mkdir -p /var/tmp/hyprland-ccache && sudo tar -C /var/tmp/hyprland-ccache -xf -'
    mark ccache-in
  fi
  vm "sudo sh ~/provision/provision.sh $user $variant $commit && rm -rf ~/provision" > "$artifacts/provision.log" 2>&1 ||
    { tail -50 "$artifacts/provision.log"; exit 1; }
  mark provision
  if [ "$variant" = git ]; then
    # Out of the guest before sealing, so the provisioned disk doesn't carry it.
    rm -rf "$cache/ccache.part"; mkdir -p "$cache/ccache.part"
    vm 'sudo tar -C /var/tmp/hyprland-ccache -cf - . && sudo rm -rf /var/tmp/hyprland-ccache && sync && sudo fstrim -a >&2' |
      tar -C "$cache/ccache.part" -xf -
    rm -rf "$cache/ccache"; mv "$cache/ccache.part" "$cache/ccache"; touch "$cache/ccache.updated"
    mark ccache-out
  fi
  halt
  vm_cpus=${E2E_VM_CPUS:-2} vm_memory=${E2E_VM_MEMORY:-4608}
  rm -f "$cache"/ready/$stale
  qemu-img convert -c -O qcow2 -o compression_type=zstd "$work/disk.qcow2" "$ready.part"
  mv "$ready.part" "$ready"
  mark seal
fi
ls -lh "$ready"

boot "$ready" ""
testing=1
mark boot
# The checkout as it is, without ignored build products.
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$root" ls-files -z -co --exclude-standard | tar -C "$root" --null --ignore-failed-read -T - -czf -
else
  tar -C "$root" --exclude=./.git --exclude=./.venv --exclude=./build --exclude=./reference -czf - .
fi | vm "mkdir -p ~/$repo && tar -C ~/$repo -xzf -"
for _ in $(seq 60); do vm 'test -s ~/.session-env' && break; sleep 2; done
# virtio-gpu's output can appear shortly after the compositor starts.
monitors='hyprctl monitors -j | python3 -c "import json,sys; sys.exit(not json.load(sys.stdin))"'
for _ in $(seq 30); do session "$monitors" && break; sleep 2; done
session "$monitors && hyprctl instances -j && hyprctl monitors"
mark session
vm 'python3 - <<EOF
import json, subprocess
versions = dict(line.split() for line in subprocess.check_output(["pacman", "-Q", "chatgpt-bin", "hyprland"], text=True).splitlines())
for name in ("cua", "sky"):
    with open(f"/usr/lib/chatgpt/resources/cua_node/lib/node_modules/@oai/{name}/package.json") as file:
        versions[f"@oai/{name}"] = json.load(file)["version"]
# E2E_HYPRLAND=git: hyprland (git-<commit>), hyprland-commit and the hyprwm libraries built from git.
try:
    with open("/var/lib/codex-e2e/hyprland.json") as file:
        versions.update(json.load(file))
except FileNotFoundError:
    pass
print(json.dumps(versions))
EOF' > "$artifacts/versions.json"
cat "$artifacts/versions.json"

launcher=
case ${E2E_INSTALL:-checkout} in
  checkout)
    session ./install 2>&1 | tee "$artifacts/install.log"
    mark install
    session ./doctor 2>&1 | tee "$artifacts/doctor.log" ;;
  plugin)
    # As a user would: `codex plugin add`, whose first start installs the latest
    # release into ~/.local/share. This tree, committed and tagged in the guest,
    # stands in for the GitHub repository. With no client on stdin, the
    # server exits once installed; the suite starts it again.
    launcher='$HOME/.codex/plugins/cache/codex-computer-use-hyprland/hyprland-computer-use/*/bin/start'
    session "git init -q && git add -A && git -c user.name=e2e -c user.email=e2e@invalid commit -qm e2e && git tag v999.0.0 &&
      codex plugin marketplace add ~/$repo && codex plugin add hyprland-computer-use@codex-computer-use-hyprland && codex mcp list &&
      { CODEX_HYPRLAND_REPO=~/$repo timeout 900 sh $launcher </dev/null || true; } &&
      test -f ~/.local/share/$repo/build/installed-release" 2>&1 | tee "$artifacts/install.log"
    mark install
    launcher=$(vm "ls -d $launcher")
    session ~/.local/share/$repo/doctor 2>&1 | tee "$artifacts/doctor.log" ;;
  *) echo "E2E_INSTALL must be checkout or plugin" >&2; exit 2 ;;
esac
mark doctor
set +e
session "E2E_STRICT_SEAT=1 E2E_OUT=~/e2e-out E2E_ONLY='${E2E_ONLY:-}' E2E_LAUNCHER=\"$launcher\" timeout -k 10 ${E2E_TIMEOUT:-1500} ./test --host" 2>&1 | tee "$artifacts/suite.log"
suite=${PIPESTATUS[0]}
set -e
mark suite
exit "$suite"
