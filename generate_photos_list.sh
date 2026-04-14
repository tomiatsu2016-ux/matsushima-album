#!/bin/bash
# ローカルで photos-list.js を生成するスクリプト
# 使い方: bash generate_photos_list.sh

echo "const PHOTO_LIST = [" > photos-list.js
for f in photos/*.{jpg,jpeg,png,gif,webp,JPG,JPEG,PNG,heic,HEIC,mp4,MP4,mov,MOV,webm,m4v}; do
  [ -f "$f" ] && echo "  '$f'," >> photos-list.js
done
echo "];" >> photos-list.js

count=$(grep -c "photos/" photos-list.js 2>/dev/null || echo 0)
echo "photos-list.js を生成しました（${count} 枚）"
