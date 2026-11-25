#!/bin/sh
# Starts SeaweedFS as a single-node S3-compatible store with one access key taken from the environment.
set -eu
cat > /tmp/s3.json <<JSON
{
  "identities": [
    {
      "name": "ticketmanager",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
JSON
exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json \
  -master.volumeSizeLimitMB=1024 -volume.max=0
