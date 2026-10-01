#!/usr/bin/env bash
# Boot a disposable Arch Linux VM (official cloud image, QEMU/KVM), install
# Hyprland and this provider the way a user would, and run the end-to-end suite
# inside a real Hyprland session. Needs x86_64 Linux with KVM, qemu and one of
# cloud-localds, xorriso or genisoimage.
#   E2E_CACHE        images (default ~/.cache/codex-hyprland-e2e): base/ holds
#                    the cloud image, ready/ the provisioned disk, rebuilt daily
#                    or when provisioning changes. Tests run on a throwaway overlay.
#   E2E_REPROVISION  set to rebuild the provisioned disk
#   E2E_ARTIFACTS    results, logs and screenshot (default ./e2e-artifacts)
#   E2E_ONLY         passed through to the suite
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
cache=${E2E_CACHE:-$HOME/.cache/codex-hyprland-e2e}
artifacts=${E2E_ARTIFACTS:-$PWD/e2e-artifacts}
image_url=https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
user=tester
repo=codex-computer-use-hyprland
mkdir -p "$cache/base" "$cache/ready" "$artifacts"
artifacts=$(cd "$artifacts" && pwd); cache=$(cd "$cache" && pwd)
work=$(mktemp -d)
: > "$artifacts/timings.txt"
started=$(date +%s)
mark() { echo "$1 $(( $(date +%s) - started ))s" | tee -a "$artifacts/timings.txt"; started=$(date +%s); }

sha=$(curl -fsSL --retry 3 "$image_url.SHA256" | cut -d ' ' -f 1)
key=$(date -u +%F)-$(cat "$here/provision.sh" "$here/hyprland.lua" "$here/openai-chatgpt.gpg" <(echo "$sha") | sha256sum | cut -c 1-16)
ready="$cache/ready/provisioned-$key.qcow2"

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
  qemu-system-x86_64 -accel kvm -cpu host -smp "${E2E_VM_CPUS:-2}" -m "${E2E_VM_MEMORY:-4608}" \
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
  boot "$base" -provision
  mark boot-provision
  tar -C "$here" -cf - provision.sh hyprland.lua openai-chatgpt.gpg | vm 'mkdir -p ~/provision && tar -C ~/provision -xf -'
  vm "sudo sh ~/provision/provision.sh $user && rm -rf ~/provision" > "$artifacts/provision.log" 2>&1 ||
    { tail -50 "$artifacts/provision.log"; exit 1; }
  mark provision
  halt
  rm -f "$cache"/ready/*.qcow2
  qemu-img convert -c -O qcow2 -o compression_type=zstd "$work/disk.qcow2" "$ready.part"
  mv "$ready.part" "$ready"
  mark seal
fi
ls -lh "$ready"

boot "$ready" ""
testing=1
mark boot
for _ in $(seq 60); do vm 'test -s ~/.session-env' && break; sleep 2; done
session 'hyprctl monitors -j | python3 -c "import json,sys; sys.exit(not json.load(sys.stdin))" || hyprctl output create headless'
session 'hyprctl instances -j; hyprctl monitors'
mark session

# The checkout as it is, without ignored build products.
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$root" ls-files -z -co --exclude-standard | tar -C "$root" --null --ignore-failed-read -T - -czf -
else
  tar -C "$root" --exclude=./.git --exclude=./.venv --exclude=./build --exclude=./reference -czf - .
fi | vm "mkdir -p ~/$repo && tar -C ~/$repo -xzf -"
session ./install 2>&1 | tee "$artifacts/install.log"
mark install
session ./doctor 2>&1 | tee "$artifacts/doctor.log"
mark doctor
set +e
session "E2E_STRICT_SEAT=1 E2E_OUT=~/e2e-out E2E_ONLY='${E2E_ONLY:-}' ./test --host" 2>&1 | tee "$artifacts/suite.log"
suite=${PIPESTATUS[0]}
set -e
mark suite
exit "$suite"
