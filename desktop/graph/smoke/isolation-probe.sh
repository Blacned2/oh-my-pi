set -eu
test "$(cat src/backend.txt)" = "isolated candidate"
test -x ./executable.sh
test "$(./executable.sh)" = "fixture executed"
test ! -e .git
test ! -S /var/run/docker.sock
test "$(ls /sys/class/net)" = lo
test "$(id -u)" = 65532
if touch /graph-root-write 2>/dev/null; then exit 1; fi
for external in "$@"; do
  test ! -e "$external"
  if touch "$external" 2>/dev/null; then exit 1; fi
done
printf 'container-only mutation\n' > src/backend.txt
printf 'Graph Tester isolation verified\n'
