#!/bin/bash

# Rutas
LOCAL_BUFFER="/home/kali/uaa-backend/offline_buffer"
NFS_MOUNT="/mnt/eData"

# Archivo testigo para probar escritura
TEST_FILE="$NFS_MOUNT/.write_test"

# Verificar si NFS está vivo intentando escribir
if touch "$TEST_FILE" 2>/dev/null; then
    rm "$TEST_FILE"

    # Si hay archivos en el buffer...
    if [ -d "$LOCAL_BUFFER" ] && [ "$(ls -A $LOCAL_BUFFER)" ]; then
        echo "[$(date)] ✅ NFS ONLINE. Sincronizando datos pendientes..."

        # Copiar y borrar del origen (mover)
        # -r: recursivo, -u: update (no sobrescribir si es más nuevo en destino), --remove-source-files: borrar origen
        rsync -avu --remove-source-files "$LOCAL_BUFFER/" "$NFS_MOUNT/"

        # Limpiar carpetas vacías que quedan
        find "$LOCAL_BUFFER" -type d -empty -delete

        echo "🎉 Sincronización completada."
    fi
fi
