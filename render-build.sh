#!/usr/bin/env bash
apt-get update
apt-get install -y wget gnupg unzip ca-certificates \
  fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 libnspr4 libnss3 \
  libxcomposite1 libxdamage1 libxrandr2 xdg-utils libu2f-udev chromium
