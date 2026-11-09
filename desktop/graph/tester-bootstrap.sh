set -eu
umask 022
cd /work
mkdir project
tar -xf -
cd project
if [ -s ../graph-executables ]; then
  xargs -0 chmod 755 -- < ../graph-executables
fi
exec "$@" </dev/null
