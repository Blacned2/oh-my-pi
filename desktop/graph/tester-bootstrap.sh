set -eu
# 111 is reserved for environment failures before the test runs; the host reports them as infrastructure errors.
fail() {
  printf 'graph-bootstrap: %s\n' "$1" >&2
  exit 111
}
umask 022
cd /work || fail "cannot enter /work"
mkdir project || fail "cannot create /work/project"
tar -xf - || fail "cannot extract the candidate snapshot"
cd project || fail "cannot enter /work/project"
if [ -s ../graph-executables ]; then
  xargs -0 chmod 755 -- < ../graph-executables || fail "cannot mark executable files"
fi
exec "$@" </dev/null
