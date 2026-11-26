#!/bin/sh
# Healthy when the last successful backup is less than 26 hours old.
f=/backups/.last-success
[ -f "$f" ] && [ -n "$(find "$f" -mmin -1560)" ]
