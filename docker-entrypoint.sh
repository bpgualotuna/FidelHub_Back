#!/bin/sh

# Salir inmediatamente si algún comando falla
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Starting application..."
exec "$@"
