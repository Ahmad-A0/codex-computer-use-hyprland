#!/usr/bin/env bash
# Boot a disposable Arch Linux VM (official cloud image, QEMU/KVM), install
# Hyprland and this provider the way a user would, and run the end-to-end suite
# inside a real Hyprland session. Needs x86_64 Linux with KVM, qemu and one of
# cloud-localds, xorriso or genisoimage.
#   E2E_CACHE      base image cache (default ~/.cache/codex-hyprland-e2e)
#   E2E_ARTIFACTS  results, logs and screenshot (default ./e2e-artifacts)
#   E2E_ONLY       passed through to the suite
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cache=${E2E_CACHE:-$HOME/.cache/codex-hyprland-e2e}
artifacts=${E2E_ARTIFACTS:-$PWD/e2e-artifacts}
image_url=https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
user=tester
repo=codex-computer-use-hyprland
mkdir -p "$cache" "$artifacts"
artifacts=$(cd "$artifacts" && pwd); cache=$(cd "$cache" && pwd)
work=$(mktemp -d)
: > "$artifacts/timings.txt"
started=$(date +%s)
mark() { echo "$1 $(( $(date +%s) - started ))s" | tee -a "$artifacts/timings.txt"; started=$(date +%s); }

# Base image, verified against the published checksum.
sha=$(curl -fsSL --retry 3 "$image_url.SHA256" | cut -d ' ' -f 1)
base="$cache/arch-cloudimg-$sha.qcow2"
if [ ! -f "$base" ]; then
  curl -fL --retry 3 -o "$base.part" "$image_url"
  echo "$sha  $base.part" | sha256sum -c --quiet
  find "$cache" -name 'arch-cloudimg-*.qcow2' -delete
  mv "$base.part" "$base"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$work/disk.qcow2" 16G

# cloud-init NoCloud seed: one passwordless-sudo user reachable by a fresh key.
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
cat > "$work/user-data" <<EOF
#cloud-config
users:
  - name: $user
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: ["$(cat "$work/key.pub")"]
EOF
printf 'instance-id: codex-hyprland-e2e\nlocal-hostname: codex-e2e\n' > "$work/meta-data"
if command -v cloud-localds >/dev/null; then
  cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"
elif command -v xorriso >/dev/null; then
  xorriso -as mkisofs -quiet -o "$work/seed.iso" -V cidata -J -r "$work/user-data" "$work/meta-data"
else
  "$(command -v genisoimage || command -v mkisofs)" -quiet -o "$work/seed.iso" -V cidata -J -r "$work/user-data" "$work/meta-data"
fi

# virtio-gpu gives the guest a KMS device, as in Hyprland's own CI VM test.
port=${E2E_SSH_PORT:-$((20000 + RANDOM % 20000))}
qemu-system-x86_64 -accel kvm -cpu host -smp "${E2E_VM_CPUS:-2}" -m "${E2E_VM_MEMORY:-4608}" \
  -drive "if=virtio,file=$work/disk.qcow2,discard=unmap" \
  -drive "if=virtio,file=$work/seed.iso,format=raw,readonly=on" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$port-:22" \
  -vga none -device virtio-gpu-pci,xres=1920,yres=1080 -display none -monitor none \
  -serial "file:$artifacts/console.log" -daemonize -pidfile "$work/qemu.pid"

vm() {
  ssh -q -i "$work/key" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o ServerAliveInterval=15 "$user@127.0.0.1" "$@"
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
  [ -z "${booted:-}" ] || collect
  [ ! -f "$work/qemu.pid" ] || kill "$(cat "$work/qemu.pid")" 2>/dev/null || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

for _ in $(seq 120); do vm true 2>/dev/null && break; sleep 5; done
vm true
booted=1
vm 'sudo cloud-init status --wait >/dev/null; true'
mark boot

# The checkout as it is, without ignored build products.
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$root" ls-files -z -co --exclude-standard | tar -C "$root" --null --ignore-failed-read -T - -czf -
else
  tar -C "$root" --exclude=./.git --exclude=./.venv --exclude=./build --exclude=./reference -czf - .
fi | vm "mkdir -p ~/$repo && tar -C ~/$repo -xzf -"
vm "sudo sh ~/$repo/tests/e2e/vm/provision.sh $user" > "$artifacts/provision.log" 2>&1 ||
  { tail -50 "$artifacts/provision.log"; exit 1; }
mark provision

for _ in $(seq 60); do vm 'test -s ~/.session-env' && break; sleep 2; done
session 'hyprctl monitors -j | python3 -c "import json,sys; sys.exit(not json.load(sys.stdin))" || hyprctl output create headless'
session 'hyprctl instances -j; hyprctl monitors'
mark session

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
