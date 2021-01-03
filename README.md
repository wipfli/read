# read
Node express server for reading data on ballometer.io

## Installation

Write a ```read.service``` file:

```
[Unit]
Description=Node express server for reading data on ballometer.io

[Service]
WorkingDirectory=/root/read
Environment=PORT=3002
ExecStart=node index.js
Restart=always
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
npm install
```

test with

```bash
PORT=3002 node index.js
```

install with

```bash
systemctl enable /root/read/read.service
systemctl start read
```
