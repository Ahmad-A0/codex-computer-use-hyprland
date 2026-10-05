#!/bin/sh
# Guest side of the end-to-end VM for E2E_HYPRLAND=git, run as root by
# provision.sh after Arch's hyprland package is installed: build Hyprland's
# development branch at COMMIT and install it over the package, which stays as
# the baseline for runtime dependencies. The result looks like a normal install:
# /usr/bin/Hyprland, start-hyprland, hyprctl, the headers in /usr/include/hyprland
# and /usr/share/pkgconfig/hyprland.pc all come from COMMIT.
# hyprwm libraries are built from git only when main needs a newer version than
# Arch ships (or links against one that is rebuilt), at the revisions pinned in
# Hyprland's flake.lock, which upstream's CI builds with. What was built is
# recorded in /var/lib/codex-e2e/hyprland.json.
#   hyprland-git.sh COMMIT
set -eu
commit=$1
work=/var/tmp/hyprland-git
record=/var/lib/codex-e2e/hyprland.json
retry() { for n in 1 2 3; do "$@" && return; echo "retrying ($n): $*" >&2; sleep 10; done; "$@"; }
started=$(date +%s)

# Arch's make dependencies of hyprland.
retry pacman -S --noconfirm --needed --noprogressbar \
  git cmake ninja meson python glaze hyprland-protocols hyprwayland-scanner xorgproto

# A compiler job of Hyprland peaks around 1.5 GB; zram absorbs the rest.
mem=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
jobs=$((mem / 1500)); [ "$jobs" -ge 1 ] || jobs=1; [ "$jobs" -le "$(nproc)" ] || jobs=$(nproc)
zram=
if modprobe zram 2>/dev/null && zram=$(zramctl -f -s "$((mem / 2))M" -a zstd 2>/dev/null); then
  mkswap -q "$zram" >/dev/null && swapon -p 100 "$zram" || zram=
fi
cleanup() {
  [ -z "$zram" ] || { swapoff "$zram"; zramctl -r "$zram"; } 2>/dev/null || true
  rm -rf "$work" /var/lib/pacman/sync/*.files
}
trap cleanup EXIT
echo "Building Hyprland $commit with $jobs jobs (${mem} MB RAM, $(nproc) CPUs)"

checkout() {  # DIR REPO REV
  rm -rf "$1"; git init -q "$1"
  retry git -C "$1" fetch -q --depth 1 "https://github.com/hyprwm/$2" "$3"
  git -C "$1" -c advice.detachedHead=false checkout -q -B main FETCH_HEAD
}
rm -rf "$work"; mkdir -p "$work"
checkout "$work/Hyprland" Hyprland "$commit"
retry git -C "$work/Hyprland" submodule -q update --init --depth 1 subprojects/hyprland-protocols subprojects/udis86

# Which hyprwm libraries to build, in build order, as "name revision" lines:
# those whose installed version is below what Hyprland (or another library
# being built) requires, and those linking against a library being rebuilt, so
# the compositor never loads two builds of one library.
python3 - "$work" > "$work/plan" <<'EOF'
import glob, json, os, re, subprocess, sys
work = sys.argv[1]
order = ['hyprwayland-scanner', 'hyprutils', 'hyprlang', 'hyprcursor', 'hyprgraphics', 'hyprwire', 'aquamarine']
links = {'hyprlang': ['hyprutils'], 'hyprcursor': ['hyprlang', 'hyprutils'], 'hyprgraphics': ['hyprutils'],
         'hyprwire': ['hyprutils'], 'aquamarine': ['hyprutils']}
nodes = json.load(open(f'{work}/Hyprland/flake.lock'))['nodes']

def vt(version):
    return tuple(int(x) for x in re.findall(r'\d+', version)[:3])

def installed(name):
    out = subprocess.run(['pacman', '-Q', name], capture_output=True, text=True).stdout.split()
    return out[1].split(':')[-1].rsplit('-', 1)[0] if len(out) == 2 else '0'

def pin(name):
    ref = nodes['root']['inputs'].get(name)
    candidates = [ref] if isinstance(ref, str) else []
    candidates += [k for k, v in nodes.items() if v.get('locked', {}).get('repo') == name]
    for key in candidates:
        rev = nodes.get(key, {}).get('locked', {}).get('rev')
        if rev:
            return rev
    out = subprocess.check_output(['git', 'ls-remote', f'https://github.com/hyprwm/{name}', 'HEAD'], text=True)
    return out.split()[0]

def requirements(tree):
    found = {}
    for path in glob.glob(f'{tree}/**/CMakeLists.txt', recursive=True):
        if re.search(r'/(subprojects|hyprtester|tests?|build|_deps)/', path[len(tree):]):
            continue
        text = open(path, errors='replace').read()
        variables = dict(re.findall(r'set\(\s*(\w+)\s+"?v?(\d[\d.]*)"?\s*\)', text))
        pairs = re.findall(r'\b(hypr[a-z-]*|aquamarine)\s*>=\s*(\$\{\w+\}|\d[\d.]*)', text)
        pairs += re.findall(r'find_package\(\s*(hypr[a-z-]*|aquamarine)\s+(\d[\d.]*)', text)
        for name, version in pairs:
            version = variables.get(version[2:-1], '0') if version.startswith('$') else version
            if name in order and vt(version) > vt(found.get(name, '0')):
                found[name] = version
    return found

def merge(into, more):
    for name, version in more.items():
        if vt(version) > vt(into.get(name, '0')):
            into[name] = version

need = requirements(f'{work}/Hyprland')
build = {}
changed = True
while changed:
    changed = False
    for name in reversed(order):
        if name in build:
            continue
        old = need.get(name) and vt(installed(name)) < vt(need[name])
        relink = [dep for dep in links.get(name, []) if dep in build]
        if not (old or relink):
            continue
        rev = pin(name)
        reason = f'needs {name} >= {need[name]}, Arch has {installed(name)}' if old else f'links {", ".join(relink)}'
        print(f'{name} {rev[:12]}: {reason}', file=sys.stderr)
        subprocess.check_call(['sh', '-c', 'git init -q "$1" && git -C "$1" fetch -q --depth 1 "$2" "$3" && '
                               'git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD',
                               'checkout', f'{work}/{name}', f'https://github.com/hyprwm/{name}', rev])
        build[name] = rev
        merge(need, requirements(f'{work}/{name}'))
        changed = True
for name in order:
    if name in build:
        print(name, build[name])
EOF
cat "$work/plan"

# Configure DIR [cmake args]; installs Arch packages for pkg-config modules the
# configure step reports missing (dependencies newer than the package's).
filesdb=
configure() {
  dir=$1; shift
  for attempt in 1 2 3 4; do
    if cmake -S "$dir" -B "$dir/build" -G Ninja -W no-dev -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_TESTING=OFF "$@" > "$dir/configure.log" 2>&1; then
      return
    fi
    # CMake lists them as "   - name>=version" after this line (optional
    # modules that are not found are reported differently and ignored).
    missing=$(sed -n '/required packages were not found/,/^Call Stack/s/^ *- *\([^ <>=]*\).*/\1/p' \
      "$dir/configure.log" | sort -u)
    [ -n "$missing" ] && [ "$attempt" -lt 4 ] || { cat "$dir/configure.log"; return 1; }
    [ -n "$filesdb" ] || { retry pacman -Fy --noprogressbar >/dev/null; filesdb=1; }
    for module in $missing; do
      package=$(pacman -Fq "usr/lib/pkgconfig/$module.pc" "usr/share/pkgconfig/$module.pc" 2>/dev/null | head -1)
      [ -n "$package" ] || { cat "$dir/configure.log"; echo "No Arch package provides $module.pc" >&2; return 1; }
      echo "Installing $package for $module"
      retry pacman -S --noconfirm --needed --noprogressbar "$package"
    done
    rm -rf "$dir/build"
  done
}

while read -r name rev; do
  echo "Building $name ${rev}"
  configure "$work/$name"
  cmake --build "$work/$name/build" -j "$jobs"
  cmake --install "$work/$name/build" > /dev/null
done < "$work/plan"
ldconfig

# As Arch's package: no hyprpm, no rpath.
configure "$work/Hyprland" -DNO_HYPRPM=ON -DCMAKE_SKIP_RPATH=ON
cmake --build "$work/Hyprland/build" -j "$jobs"
# Headers exactly as main has them, without the package's leftovers.
rm -rf /usr/include/hyprland
cmake --install "$work/Hyprland/build" > /dev/null
rm -f /usr/include/hyprland/src/version.h.in
ldconfig

installed=$(sed -n 's/^#define GIT_COMMIT_HASH *"\(.*\)"/\1/p' /usr/include/hyprland/src/version.h)
[ "$installed" = "$commit" ] || { echo "Installed headers are for $installed, not $commit" >&2; exit 1; }
Hyprland --version | head -3
echo "pkg-config hyprland: $(pkg-config --modversion hyprland)"

mkdir -p "${record%/*}"
python3 - "$commit" "$work/plan" > "$record" <<'EOF'
import json, sys
versions = {'hyprland': f'git-{sys.argv[1][:12]}', 'hyprland-commit': sys.argv[1]}
for line in open(sys.argv[2]):
    name, rev = line.split()
    versions[name] = f'git-{rev[:12]}'
print(json.dumps(versions))
EOF
cat "$record"
echo "Hyprland from git built in $(( $(date +%s) - started ))s (build tree $(du -sh "$work" | cut -f 1), removed)"
