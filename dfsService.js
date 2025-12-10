// dfsService.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptJson, decryptJson } = require('./cryptoService');

const DFS_BASE_PATH = process.env.DFS_BASE_PATH || '/mnt/eData';
// Carpeta de emergencia local (Buffer)
const LOCAL_BUFFER_PATH = path.join(__dirname, 'offline_buffer');

// Asegurar que existe el buffer local al iniciar
if (!fs.existsSync(LOCAL_BUFFER_PATH)) {
  fs.mkdirSync(LOCAL_BUFFER_PATH, { recursive: true });
}

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getFolderPath(folderName, isOffline = false) {
  const base = isOffline ? LOCAL_BUFFER_PATH : DFS_BASE_PATH;
  return path.join(base, folderName);
}

// Calcula checksum SHA-256
function calcChecksumFromObject(obj) {
  const json = JSON.stringify(obj);
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

// =================== ESCRITURA TOLERANTE A FALLOS ===================
function saveEncrypted(folderName, id, payload) {
  // 1. Preparar el contenido cifrado
  const checksum = calcChecksumFromObject(payload);
  const cipherBase64 = encryptJson(payload); 

  const wrapper = {
    version: 1,
    algorithm: 'RSA-OAEP-SHA256',
    checksum,
    cipher: cipherBase64
  };

  const dataToWrite = JSON.stringify(wrapper, null, 2);
  const fileName = `${id}.json`;

  // 2. Intentar guardar en NFS (Plan A - Online)
  try {
    const nfsDir = getFolderPath(folderName, false);
    
    // Verificación rápida de escritura en NFS
    // (fs.accessSync lanza error si el NFS está desconectado/roto)
    if (!fs.existsSync(nfsDir)) ensureDirExists(nfsDir);
    
    const nfsPath = path.join(nfsDir, fileName);
    fs.writeFileSync(nfsPath, dataToWrite, 'utf8');
    
    console.log(`✅ [ONLINE] Guardado en NFS: ${folderName}/${fileName}`);
    return { filePath: nfsPath, checksum, mode: 'ONLINE' };

  } catch (err) {
    // 3. FALLO NFS -> Guardar en Local (Plan B - Offline)
    console.error(`⚠️ [OFFLINE] Fallo NFS (${err.message}). Guardando en buffer local...`);
    
    try {
        const localDir = getFolderPath(folderName, true);
        ensureDirExists(localDir);
        const localPath = path.join(localDir, fileName);
        
        fs.writeFileSync(localPath, dataToWrite, 'utf8');
        console.log(`💾 [BUFFER] Respaldo local exitoso: ${folderName}/${fileName}`);
        return { filePath: localPath, checksum, mode: 'OFFLINE' };
    } catch (localErr) {
        console.error("❌ ERROR CRÍTICO: No se pudo escribir ni en NFS ni en Local", localErr);
        throw localErr; 
    }
  }
}

// =================== LECTURA HÍBRIDA ===================
function readEncrypted(folderName, id) {
  const fileName = `${id}.json`;
  const localPath = path.join(getFolderPath(folderName, true), fileName);
  const nfsPath = path.join(getFolderPath(folderName, false), fileName);

  let content = null;

  // 1. Buscar primero en buffer local (prioridad a lo recién creado offline)
  if (fs.existsSync(localPath)) {
    try {
        content = fs.readFileSync(localPath, 'utf8');
    } catch(e) {}
  } 
  
  // 2. Si no está en local, intentar leer de NFS
  if (!content) {
    try {
        if (fs.existsSync(nfsPath)) {
            content = fs.readFileSync(nfsPath, 'utf8');
        }
    } catch (e) {
        console.warn(`⚠️ No se pudo leer NFS: ${e.message}`);
        // Si es login y falla el NFS, lanzamos error específico
        if (folderName === 'usuarios') throw new Error('SYSTEM_OFFLINE');
    }
  }

  if (!content) {
    throw new Error('NOT_FOUND');
  }

  // Descifrar
  const wrapper = JSON.parse(content);
  if (!wrapper.cipher) throw new Error('INVALID_FORMAT');

  const payload = decryptJson(wrapper.cipher);
  return payload;
}

// =================== LISTADO UNIFICADO ===================
function listAllEncrypted(folderName) {
  const localDir = getFolderPath(folderName, true);
  const nfsDir = getFolderPath(folderName, false);
  
  const fileSet = new Set(); 

  // 1. Listar Local
  try {
    if (fs.existsSync(localDir)) {
        fs.readdirSync(localDir).filter(f => f.endsWith('.json')).forEach(f => fileSet.add(f));
    }
  } catch(e) {}

  // 2. Listar NFS (si está disponible)
  try {
    if (fs.existsSync(nfsDir)) {
        fs.readdirSync(nfsDir).filter(f => f.endsWith('.json')).forEach(f => fileSet.add(f));
    }
  } catch (e) {
    console.warn(`⚠️ Listado parcial: NFS no disponible para ${folderName}`);
  }

  // 3. Leer y descifrar todo
  const results = [];
  for (const file of fileSet) {
    const id = path.basename(file, '.json');
    try {
      const obj = readEncrypted(folderName, id);
      results.push(obj);
    } catch (err) {
      // Ignorar archivos corruptos o ilegibles
    }
  }

  return results;
}

module.exports = {
  DFS_BASE_PATH,
  saveEncrypted,
  readEncrypted,
  listAllEncrypted
};
