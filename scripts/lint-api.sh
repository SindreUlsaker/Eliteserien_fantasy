#!/bin/sh
cd apps/api && eslint "$@" --ext .ts
