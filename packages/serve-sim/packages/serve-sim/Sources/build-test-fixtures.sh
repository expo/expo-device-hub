#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/ServeSimProbe/build.sh"
bash "$HERE/ServeSimLaunchFixture/build.sh"
