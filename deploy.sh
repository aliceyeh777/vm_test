#!/bin/bash
set -e

VPS="root@147.182.172.24"
REMOTE_DIR="/opt/mock-jihan"

echo "==> git push to GitHub ..."
git push

echo "==> VPS: git pull + pm2 restart ..."
ssh "$VPS" "cd $REMOTE_DIR && git pull && pm2 restart mock-jihan"

echo "==> Deploy done!"
