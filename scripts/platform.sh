# Shims so the build and install scripts also work on Windows under Git Bash.
# Sourced after tizen-env.sh. No-ops on macOS and Linux.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # tizen ships as a .bat with no POSIX execute bit, so `command -v` in POSIX
    # sh never finds it (it runs fine by absolute path). Resolve both tools
    # from TIZEN_HOME instead of relying on a PATH lookup.
    TIZEN_CMD="$TIZEN_HOME/tools/ide/bin/tizen.bat"
    SDB_CMD="$TIZEN_HOME/tools/sdb.exe"
    have_tizen() { [ -f "$TIZEN_CMD" ]; }
    # Native tools can't read /c/... paths, so hand them Windows ones.
    winpath() { cygpath -w "$1"; }
    ;;
  *)
    TIZEN_CMD=tizen
    SDB_CMD=sdb
    have_tizen() { command -v "$TIZEN_CMD" >/dev/null 2>&1; }
    winpath() { printf '%s' "$1"; }
    ;;
esac
export TIZEN_CMD SDB_CMD
