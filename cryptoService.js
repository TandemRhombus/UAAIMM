// cryptoService.js
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Cargamos las llaves RSA desde los paths configurados
const privateKeyPath = process.env.RSA_PRIVATE_KEY_PATH || './keys/private.pem';
const publicKeyPath = process.env.RSA_PUBLIC_KEY_PATH || './keys/public.pem';

const absolutePrivateKeyPath = path.resolve(privateKeyPath);
const absolutePublicKeyPath = path.resolve(publicKeyPath);

if (!fs.existsSync(absolutePrivateKeyPath)) {
  throw new Error(`No se encontró la llave privada RSA en: ${absolutePrivateKeyPath}`);
}
if (!fs.existsSync(absolutePublicKeyPath)) {
  throw new Error(`No se encontró la llave pública RSA en: ${absolutePublicKeyPath}`);
}

const privateKey = fs.readFileSync(absolutePrivateKeyPath, 'utf8');
const publicKey = fs.readFileSync(absolutePublicKeyPath, 'utf8');

// --- CIFRADO HÍBRIDO (AES + RSA) ---
// Esto permite cifrar archivos grandes sin el error "data too large for key size"

function encryptJson(obj) {
  const json = JSON.stringify(obj);

  // 1. Generar llave simétrica aleatoria (AES-256) y un IV
  const aesKey = crypto.randomBytes(32); // 256 bits
  const iv = crypto.randomBytes(16);     // 128 bits

  // 2. Cifrar los datos grandes con AES
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  let encryptedData = cipher.update(json, 'utf8', 'base64');
  encryptedData += cipher.final('base64');

  // 3. Cifrar la llave AES con RSA (Esto es lo único que RSA cifra)
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    aesKey
  );

  // 4. Empaquetar todo junto
  // Formato: IV (base64) : LlaveAES_Cifrada (base64) : Datos_Cifrados (base64)
  const package = `${iv.toString('base64')}:${encryptedAesKey.toString('base64')}:${encryptedData}`;

  return package;
}

function decryptJson(packageStr) {
  // 1. Desempaquetar
  const parts = packageStr.split(':');
  
  // Compatibilidad: Si el string no tiene 3 partes, intentamos descifrar como RSA puro
  // (para leer los archivos viejos pequeños que ya creaste)
  if (parts.length !== 3) {
      try {
        return decryptJsonLegacy(packageStr);
      } catch (e) {
        throw new Error('Formato de cifrado desconocido o corrupto');
      }
  }

  const iv = Buffer.from(parts[0], 'base64');
  const encryptedAesKey = Buffer.from(parts[1], 'base64');
  const encryptedData = parts[2];

  // 2. Descifrar la llave AES usando RSA Privada
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    encryptedAesKey
  );

  // 3. Descifrar los datos grandes usando la llave AES recuperada
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  let decryptedData = decipher.update(encryptedData, 'base64', 'utf8');
  decryptedData += decipher.final('utf8');

  return JSON.parse(decryptedData);
}

// Función auxiliar para leer los archivos viejos (Solo RSA)
function decryptJsonLegacy(base64Cipher) {
  const buffer = Buffer.from(base64Cipher, 'base64');
  const decrypted = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    buffer
  );
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  encryptJson,
  decryptJson
};
