# I2P Share - Système de Partage Décentralisé Anonyme
## Spécification Technique Complète

*Un client P2P décentralisé pour le partage de fichiers anonyme, inspiré de SoulseekQT mais sans censure ni filtrage, pour tous types de fichiers, sur Windows/macOS/Linux*

---

## Table des matières

1. [Vision & Objectifs](#vision--objectifs)
2. [Architecture Globale](#architecture-globale)
3. [Protocole Réseau](#protocole-réseau)
4. [Structure de Données](#structure-de-données)
5. [Système de Recherche Distribué](#système-de-recherche-distribué)
6. [Gestion des Fichiers](#gestion-des-fichiers)
7. [Interface Utilisateur](#interface-utilisateur)
8. [Stack Technique](#stack-technique)
9. [Implémentation Détaillée](#implémentation-détaillée)
10. [Plan de Développement](#plan-de-développement)

---

## Vision & Objectifs

### Principes Fondamentaux

1. **100% Décentralisé** : Aucun serveur central pour le contrôle, uniquement pour le bootstrap initial
2. **Anonymat Total** : IP réelle jamais exposée, communication via I2P (Invisible Internet Project)
3. **Pas de Censure** : Aucun filtrage, Web of Trust ou système de réputation obligatoire
4. **Tous les Fichiers** : Contrairement à SoulseekQT (limité à la musique), support de tous types de fichiers
5. **Cross-Platform** : Windows, macOS, Linux avec une expérience identique
6. **Résilience NAT/Firewall** : Fonctionne sur 4G, réseau d'entreprise, firewalls stricts

### Avantages vs SoulseekQT

| Aspect | SoulseekQT | I2P Share |
|--------|-----------|----------|
| **Anonymat** | Pseudonyme, IP visible | IP complètement masquée |
| **Types de fichiers** | Musique principalement | Tous types |
| **Architecture** | Serveur central | 100% décentralisé |
| **Censure** | Serveur peut bloquer contenu | Aucun point de contrôle |
| **Cross-platform** | Windows, macOS, Linux | Windows, macOS, Linux (natif) |
| **Recherche** | Serveur central + P2P | DHT Kademlia pure P2P |

---

## Architecture Globale

### Diagramme Conceptuel

```
┌─────────────────────────────────────────────────────────────────┐
│                    I2P Share - Client Desktop                    │
│                      (Electron + Node.js)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  UI Layer (React)                                        │   │
│  │  - Écran de recherche                                    │   │
│  │  - Résultats en temps réel                              │   │
│  │  - Gestion des téléchargements                          │   │
│  │  - Gestion des partages (dossiers)                      │   │
│  │  - Chat P2P (optionnel)                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          ↓ IPC                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Business Logic (Node.js Main Process)                  │   │
│  │  - Gestionnaire de recherche                            │   │
│  │  - Gestion des connexions P2P                           │   │
│  │  - Indexation locale des fichiers                       │   │
│  │  - Queue de téléchargement                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  I2P Layer (@diva.exchange/i2p-sam)                     │   │
│  │  - Communication anonyme via I2P                        │   │
│  │  - Gestion des tunnels                                  │   │
│  │  - SAM API integration                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          ↓ (TCP SAM)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│              ┌─────────────────────────────────┐                │
│              │   i2pd Router (Docker)           │                │
│              │ - Chiffrement                    │                │
│              │ - Tunnels I2P                    │                │
│              │ - Routage anonyme                │                │
│              └─────────────────────────────────┘                │
│                          ↓                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│   🌐 I2P Network (Invisible Internet Project)                    │
│   - Des milliers de pairs anonymes                              │
│   - Votre IP réelle jamais exposée                             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Composants Principaux

**1. Frontend (Electron + React)**
- Interface utilisateur cross-platform
- Communication avec le backend via IPC
- Gestion d'état avec Redux/Zustand

**2. Backend (Node.js)**
- Serveur qui gère la logique métier
- Indexation locale des fichiers
- Orchestration des recherches DHT
- Gestion des téléchargements/uploads

**3. I2P Router (i2pd)**
- Daemon I2P en sidecar Docker
- Expose l'API SAM sur localhost:7656
- Gère les tunnels anonymes

**4. Base de Données Locale (SQLite)**
- Métadonnées des fichiers locaux
- Cache DHT
- État des téléchargements
- Historique de recherche

---

## Protocole Réseau

### Couches de Communication

```
Couche 7 (Applicatif)
├─ Recherche (DHT)
├─ Transfert de fichiers (Streaming TCP)
└─ Métadonnées (JSON)

Couche 5 (Session)
└─ I2P SAM Protocol (commands/responses)

Couche 3 (Réseau)
└─ I2P Tunnels (Onion Routing)
   ├─ NTCP2 (TCP)
   └─ SSU2 (UDP avec Hole Punching)

Couches 1-2 (IP/Hardware)
└─ Connexion Internet standard (votre ISP)
```

### Messages I2P Share (Serialisé en JSON + Binary)

#### 1. Annonce de Présence (P2P Gossip)

```json
{
  "type": "peer_announce",
  "userId": "base64_public_key",
  "displayName": "CyberPunkDJ21",
  "avatar": "data:image/png;base64,...",
  "bio": "Partage de musique et films",
  "filesCount": 127,
  "totalSize": 450000000000,
  "timestamp": 1738086000,
  "signature": "base64_signature"
}
```

Publié dans la DHT sous clé : `peer:${hash_clé_publique}`

#### 2. Requête de Recherche (Distributed via DHT)

```json
{
  "type": "search_request",
  "searchId": "uuid_unique",
  "query": "Blade Runner",
  "filters": {
    "fileType": "video",
    "minSize": 1000000000,
    "maxSize": 55000000000
  },
  "hops": 3,
  "timestamp": 1738086000,
  "originPeerId": "destination_i2p_rechercheur"
}
```

Les pairs reçoivent cette requête via DHT et la propagent aux pairs voisins.

#### 3. Réponse de Recherche (Unicast via I2P)

```json
{
  "type": "search_response",
  "searchId": "uuid_unique",
  "results": [
    {
      "filename": "Blade Runner 2049 (2160p).mkv",
      "fileHash": "sha256_du_fichier",
      "size": 55000000000,
      "mimeType": "video/x-matroska",
      "peerId": "destination_i2p_seedeur",
      "peerDisplayName": "CyberPunkDJ21",
      "addedAt": 1737900000,
      "quality": "2160p"
    }
  ],
  "timestamp": 1738086000
}
```

Retournée directement au pair qui a lancé la recherche.

#### 4. Requête de Téléchargement de Fichier

```json
{
  "type": "file_request",
  "fileHash": "sha256_du_fichier",
  "range": {
    "start": 0,
    "end": 262144
  }
}
```

Suivi d'un transfer binaire de 262 KB du chunk.

#### 5. Annonce DHT d'Index de Fichiers

```json
{
  "type": "file_index",
  "peerId": "destination_i2p",
  "files": [
    {
      "hash": "sha256_1",
      "name": "song1.flac",
      "size": 35000000,
      "type": "audio/flac",
      "timestamp": 1738086000
    }
  ],
  "signature": "base64_signature",
  "timestamp": 1738086000
}
```

Publié sous clé : `fileindex:${peerId}` (répliqué k=3 pairs les plus proches)

### Protocole SAM (I2P Integration)

Chaque message Node.js → i2pd passe par SAM (Simple Anonymous Messaging):

```
CLIENT → I2PD:
STREAM CONNECT ID=mystream DESTINATION=longclefb32.i2p

I2PD → CLIENT:
STREAM STATUS ID=mystream RESULT=OK

CLIENT → I2PD:
<binary_data_to_send>

I2PD → CLIENT:
STREAM RECEIVED ID=stream_recu DATA=<binary_data>
```

Implémenté via `@diva.exchange/i2p-sam` (voir [web:17]).

---

## Structure de Données

### Base de Données Locale (SQLite)

#### Table: `local_files`
```sql
CREATE TABLE local_files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  hash TEXT UNIQUE NOT NULL,
  size INTEGER NOT NULL,
  mimeType TEXT,
  modifiedAt INTEGER,
  sharedAt INTEGER,
  isShared BOOLEAN DEFAULT 1,
  createdAt INTEGER
);

CREATE INDEX idx_hash ON local_files(hash);
CREATE INDEX idx_isShared ON local_files(isShared);
```

#### Table: `dht_cache`
```sql
CREATE TABLE dht_cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  expiresAt INTEGER,
  lastUpdated INTEGER
);
```

#### Table: `downloads`
```sql
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  fileHash TEXT,
  peerId TEXT,
  peerName TEXT,
  totalSize INTEGER,
  downloadedSize INTEGER,
  status TEXT,
  createdAt INTEGER,
  startedAt INTEGER,
  completedAt INTEGER,
  chunkMap TEXT
);

CREATE INDEX idx_status ON downloads(status);
```

#### Table: `peers`
```sql
CREATE TABLE peers (
  id INTEGER PRIMARY KEY,
  peerId TEXT UNIQUE,
  displayName TEXT,
  avatar TEXT,
  bio TEXT,
  filesCount INTEGER,
  totalSize INTEGER,
  firstSeen INTEGER,
  lastSeen INTEGER,
  trustScore INTEGER,
  isBlocked BOOLEAN DEFAULT 0
);

CREATE INDEX idx_lastSeen ON peers(lastSeen);
```

### Fichiers de Configuration

#### `config.json` (Local + Encrypted)
```json
{
  "identity": {
    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    "privateKey": "-----BEGIN ENCRYPTED PRIVATE KEY-----...",
    "userId": "a3f5d8c2...",
    "displayName": "CyberPunkDJ21"
  },
  "network": {
    "samHost": "127.0.0.1",
    "samPort": 7656,
    "i2pDestination": "6Jjh8bfKJ8...b32.i2p",
    "maxConnections": 50
  },
  "sharing": {
    "sharedFolders": [
      "/home/user/Music",
      "/home/user/Downloads"
    ],
    "maxUploadSlots": 10,
    "maxUploadBandwidth": 5242880
  },
  "search": {
    "maxResults": 100,
    "searchTimeout": 10000,
    "kademliaBucket": 20
  }
}
```

#### `.i2pshare` Files (Partageables)
```json
{
  "version": 1,
  "name": "Miles Davis Collection",
  "creator": "CyberPunkDJ21",
  "description": "Collection complète de Miles Davis en FLAC",
  "files": [
    {
      "name": "01 - So What.flac",
      "hash": "sha256_hash1",
      "size": 40000000
    }
  ],
  "totalSize": 450000000,
  "createdAt": 1738086000,
  "peerId": "creator_destination_i2p",
  "signature": "base64_sig"
}
```

---

## Système de Recherche Distribué

### Algorithme Kademlia DHT

#### Phase 1: Initialisation
1. Chaque pair a un `nodeId` = `SHA256(sa_clé_publique)` (160 bits)
2. Construit une **Routing Table** (K-bucket tree)
3. K = 20 (nombre de voisins par bucket)

#### Phase 2: Découverte de Voisins
```
Au démarrage :
1. Se connecter aux pairs de Bootstrap (publics)
2. Envoyer "PING" → récupère liste de pairs proches
3. Récursivement, contacter pairs proches
4. Après 5 minutes, a une vue locale du réseau (~100-500 pairs connus)
```

#### Phase 3: Recherche (FIND_VALUE)
```
Utilisateur tape : "Blade Runner"
↓
searchHash = SHA256("Blade Runner")
↓
Trouver les 3 pairs les plus proches de searchHash dans routing table
↓
Envoyer à ces 3 pairs : { type: 'FIND_VALUE', key: searchHash }
↓
Chaque pair répond avec :
  - Soit les résultats stockés localement
  - Soit une liste de pairs plus proches
↓
Itération jusqu'à trouver ou timeout
```

Complexité: O(log n) où n = nombre de pairs total (~1-10 sauts)

#### Phase 4: Réplication
- Les fichiers populaires sont répliqués chez les 3 pairs les plus proches
- TTL (Time To Live) = 3600 secondes
- Reannonce automatique

### Critères de Recherche

```javascript
// Structure du filtre
{
  query: string,               // "Blade Runner"
  fileType: string,            // "video", "audio", "image", "*"
  minSize: number,             // bytes
  maxSize: number,             // bytes
  mimeType: string,            // "video/x-matroska", "audio/flac"
  uploadSpeed: number,         // peers avec upload > X KB/s
  duration: number,            // Pour vidéos/audio (secondes)
  tags: string[],              // ["4k", "sci-fi", "2024"]
  exactMatch: boolean          // Recherche exacte vs fuzzy
}
```

### Ranking des Résultats

```javascript
score = (
  (queryMatch * 40) +           // Score de pertinence texte
  (seeders * 20) +              // Nombre de seeders
  (popularity * 15) +           // Fichier populaire (requests)
  (uploadSpeed * 15) +          // Vitesse d'upload du pair
  (peerAge * 10)                // Ancienneté du pair (stabilité)
) / 100

// Trier par score descendant
```

---

## Gestion des Fichiers

### Workflow d'Upload

```
1. Utilisateur sélectionne dossier via UI
   ↓
2. Scanner récursif des fichiers
   ↓
3. Pour chaque fichier:
   a. Calculer SHA256
   b. Extraire métadonnées (taille, type MIME, durée pour médias)
   c. Insérer dans local_files
   ↓
4. Créer index local "file_index"
   ↓
5. Publier dans DHT:
   - Clé: fileindex:{peerId}
   - Valeur: JSON compressé gzipped
   - TTL: 3600s (ré-annoncé toutes les 30 min)
   ↓
6. Écouter sur le port SAM pour les connexions entrantes
   ↓
7. Servir les chunks demandés
```

### Serveur de Fichiers (Accepteur)

```javascript
// Écoute sur un port I2P virtuel
const server = await i2pSam.createStream({
  sam: { host: '127.0.0.1', portTCP: 7656 },
  stream: { privateKey: myPrivateKey }
});

server.on('stream', (socket) => {
  let buffer = '';
  
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    
    if (buffer.includes('\n')) {
      const message = JSON.parse(buffer);
      
      if (message.type === 'file_request') {
        const file = db.get('SELECT path FROM local_files WHERE hash = ?', 
                            [message.fileHash]);
        
        const stream = fs.createReadStream(file.path, {
          start: message.range.start,
          end: message.range.end
        });
        
        stream.pipe(socket);
      }
    }
  });
});
```

### Client de Téléchargement (Requêteur)

```javascript
async function downloadFile(fileHash, peerId, filename) {
  // 1. Établir connexion I2P avec le seeder
  const peerStream = await i2pSam.createStream({
    destination: peerId
  });
  
  // 2. Calculer nombre de chunks
  const fileSize = 55000000000;  // 55 GB
  const chunkSize = 262144;       // 256 KB
  const chunks = Math.ceil(fileSize / chunkSize);
  
  // 3. Télécharger par chunks (parallèle: 4 streams)
  const chunkMap = new Array(chunks).fill(false);
  
  for (let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, fileSize - 1);
    
    // Demander chunk
    const request = {
      type: 'file_request',
      fileHash: fileHash,
      range: { start, end }
    };
    
    peerStream.write(JSON.stringify(request) + '\n');
    
    // Recevoir et écrire sur disque
    const chunkData = await readExactly(peerStream, end - start + 1);
    fs.appendFileSync(`downloads/${filename}.part`, chunkData);
    
    chunkMap[i] = true;
    updateDownloadProgress(fileHash, chunkMap);
    
    // Limiter concurrence
    if (i % 4 === 0) await delay(100);
  }
  
  // 4. Vérifier intégrité avec hash
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(`downloads/${filename}.part`);
  
  stream.on('data', data => hash.update(data));
  stream.on('end', () => {
    if (hash.digest('hex') === fileHash) {
      fs.renameSync(`downloads/${filename}.part`, `downloads/${filename}`);
    }
  });
}
```

### Déduplication Smart

Pour économiser l'espace disque lors du partage:

```javascript
// Si plusieurs sources partagent le même fichier
const duplicates = db.all(
  'SELECT * FROM local_files WHERE hash = ? AND isShared = 1',
  [fileHash]
);

// Hardlink sur Linux/macOS, ou copy-on-write sur Windows
if (duplicates.length > 1) {
  fs.linkSync(duplicates[0].path, duplicates[1].path);
  // Économise X GB
}
```

---

## Interface Utilisateur

### Layout Principal (Electron + React)

```
┌────────────────────────────────────────────────────────────┐
│ 🔍 I2P Share                  [_] [—] [X]                  │
├────────────────────────────────────────────────────────────┤
│  🔎 [Recherche...............] 🔽  ⚙️                       │
│                                                             │
│  Filtres avancés:                                          │
│  Type: [Tous ▼]  Taille: [Tous ▼]  Upload: [Tous ▼]      │
│                                                             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Résultats (327 trouvés):                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 📹 Blade Runner 2049.mkv (2160p) - 55 GB            │   │
│  │    👤 CyberPunkDJ21 | ⬇️ 2.5 MB/s | 12 peers      │   │
│  │    ⭐ 4.8/5 | Ajouté: 2 jours ago                   │   │
│  │    [TÉLÉCHARGER] [+ AJOUTER À QUEUE]               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🎵 Blade Runner Soundtrack (FLAC) - 450 MB          │   │
│  │    👤 MusicLover99 | ⬇️ 1.8 MB/s | 7 peers        │   │
│  │    ⭐ 4.9/5 | Ajouté: 1 week ago                    │   │
│  │    [TÉLÉCHARGER] [+ AJOUTER À QUEUE]               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
├────────────────────────────────────────────────────────────┤
│  📥 Téléchargements:                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✓ Inception (2010).mkv       100% ✓                │   │
│  │ ⟳ Matrix Reloaded.mkv        45% [███░░░░░░░]     │   │
│  │ ⏸ Tenet.mkv                  12% [█░░░░░░░░░]     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### Onglets de Navigation

1. **Recherche** : Interface principale ci-dessus
2. **Mes Partages** : Gestion des dossiers partagés
3. **Téléchargements** : Historique et queue
4. **Paramètres** : Configuration réseau, dossiers, thème
5. **Profil** : Nom, avatar, bio (optionnel)

### Écran "Mes Partages"

```
┌────────────────────────────────────────────────────────────┐
│ 📤 Mes Partages                                            │
├────────────────────────────────────────────────────────────┤
│  [+ Ajouter Dossier] [Actualiser Index] [Paramètres]      │
│                                                             │
│  Dossiers partagés:                                        │
│  ✓ /home/user/Music (12,547 fichiers | 450 GB)            │
│  ✓ /home/user/Videos (287 fichiers | 1.2 TB)             │
│  ✓ /home/user/Documents (15,234 fichiers | 45 GB)        │
│                                                             │
│  Stats:                                                    │
│  Total partagé: 1.7 TB                                    │
│  Fichiers: 28,068                                         │
│  Peers connectés: 47                                      │
│  Upload actif: 2.3 MB/s (4 uploads)                       │
│  Mon Destination I2P:                                     │
│  [6Jjh8bfKJ8...kM0sEb32.i2p]  [Copier]                   │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### Écran "Paramètres"

```
┌────────────────────────────────────────────────────────────┐
│ ⚙️ Paramètres                                              │
├────────────────────────────────────────────────────────────┤
│  Réseau:                                                   │
│  ✓ I2P: Connecté (12 tunnels actifs)                      │
│    Routing Speed: 4.2 secs (normal)                        │
│    Cumulative Bandwidth: 450 GB/mois                       │
│                                                             │
│  Partage:                                                  │
│  Upload max: 10 MB/s  [Limiter: __] MB/s                 │
│  Slots d'upload: 10   [Changer: __]                       │
│  Upload chiffré: ☑️                                        │
│                                                             │
│  Téléchargement:                                           │
│  Dossier de destination: [/home/user/Downloads]           │
│  Chunks parallèles: [4▼]                                   │
│  Resume partiel: ☑️                                        │
│                                                             │
│  Confidentialité:                                          │
│  Masquer mon nom d'affichage aux peers: ☐                 │
│  Accepter les messages directs: ☑️                        │
│  Rapport de crash anonyme: ☑️                             │
│                                                             │
│  [Sauvegarder]                                             │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### Dark Mode & Thème

- Support Light/Dark automatique (suivre OS)
- Design system minimalist et performant
- Icônes SVG (pas d'images lourdes)

---

## Stack Technique

### Frontend

```
Electron 33+
├─ React 18+
│  ├─ react-router-dom (navigation)
│  ├─ zustand (state management)
│  └─ tailwindcss (styling)
├─ TypeScript
└─ electron-builder (packaging cross-platform)
```

### Backend (Node.js)

```
Node.js 20+
├─ @diva.exchange/i2p-sam (I2P integration)
├─ sqlite3 (local database)
├─ kademlia (DHT implementation)
├─ express (API optionnel)
├─ bullmq (job queue pour téléchargements)
└─ zod (validation)
```

### Infrastructure

```
Docker:
├─ i2pd:latest (I2P router)
└─ Optionnel: Redis (cache DHT)

Système:
├─ Windows 10+ / macOS 10.13+ / Ubuntu 20.04+
└─ RAM: 512 MB minimum (2 GB recommandé)
    Disque: 5 GB pour app + logs
```

### Dépendances Clés NPM

```json
{
  "dependencies": {
    "@diva.exchange/i2p-sam": "^1.1.1",
    "sqlite3": "^5.1.6",
    "kademlia": "^1.0.0",
    "crypto": "builtin",
    "fs": "builtin",
    "electron": "^33.0.0",
    "react": "^18.0.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "eslint": "^8.0.0",
    "electron-builder": "^24.0.0"
  }
}
```

---

## Implémentation Détaillée

### 1. Démarrage de l'Application

**`main.js` (Electron Main Process)**

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const I2PSamClient = require('@diva.exchange/i2p-sam').createClient;
const Database = require('sqlite3').Database;
const fs = require('fs');
const path = require('path');

let mainWindow;
let i2pClient;
let db;
let fileServer;

// Initialiser I2P
async function initI2P() {
  i2pClient = I2PSamClient({
    host: '127.0.0.1',
    port: 7656
  });
  
  console.log('I2P SAM connecté');
  
  // Générer ou charger l'identité I2P persistante
  try {
    const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    i2pClient.setPrivateKey(config.network.i2pPrivateKey);
  } catch (e) {
    console.log('Première connexion - génération nouvelle identité');
    // Sera sauvegardée après première génération
  }
  
  // Démarrer le serveur de fichiers
  startFileServer();
}

// Initialiser la base de données
function initDatabase() {
  db = new Database(':memory:');
  
  db.serialize(() => {
    // Créer toutes les tables (voir Structure de Données)
    fs.readFileSync('schema.sql', 'utf8')
      .split(';')
      .forEach(statement => {
        if (statement.trim()) db.run(statement);
      });
  });
  
  console.log('Base de données initialisée');
}

// Créer la fenêtre principale
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  
  mainWindow.loadFile('dist/index.html');
}

// Écouter la demande de recherche depuis l'UI
ipcMain.handle('search', async (event, query, filters) => {
  return await performSearch(query, filters);
});

// Écouter les demandes de téléchargement
ipcMain.handle('download', async (event, fileHash, peerId, filename) => {
  return await downloadFile(fileHash, peerId, filename);
});

app.on('ready', async () => {
  await initI2P();
  initDatabase();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

### 2. Système de Recherche

**`search.js`**

```javascript
const crypto = require('crypto');

class DHTSearchEngine {
  constructor(i2pClient, db) {
    this.i2pClient = i2pClient;
    this.db = db;
    this.routingTable = new Map();  // Peers connus localement
    this.searchTimeouts = new Map();
  }
  
  // Hash une requête de recherche pour DHT
  hashQuery(query) {
    return crypto.createHash('sha256').update(query).digest('hex');
  }
  
  // Recherche Kademlia
  async findValue(key, maxResults = 100) {
    const searchHash = this.hashQuery(key);
    
    // Trouver les 3 peers les plus proches
    const closestPeers = this.getClosestPeers(searchHash, 3);
    
    const results = [];
    const visited = new Set();
    const queue = [...closestPeers];
    
    while (queue.length > 0 && results.length < maxResults) {
      const peer = queue.shift();
      
      if (visited.has(peer.id)) continue;
      visited.add(peer.id);
      
      try {
        // Envoyer FIND_VALUE request
        const response = await this.sendMessage(peer.destination, {
          type: 'FIND_VALUE',
          key: searchHash
        }, 5000);  // 5 sec timeout
        
        if (response.value) {
          results.push(...response.value);
        }
        
        // Ajouter peers plus proches à la queue
        if (response.closerPeers) {
          for (const closerPeer of response.closerPeers) {
            if (!visited.has(closerPeer.id)) {
              queue.push(closerPeer);
            }
          }
        }
      } catch (e) {
        console.error(`Erreur contacting ${peer.id}:`, e.message);
      }
    }
    
    return results;
  }
  
  // Obtenir les K peers les plus proches d'un hash
  getClosestPeers(targetHash, k = 20) {
    const peers = Array.from(this.routingTable.values());
    
    // Trier par distance XOR
    peers.sort((a, b) => {
      const distA = this.xorDistance(targetHash, a.id);
      const distB = this.xorDistance(targetHash, b.id);
      return distA - distB;
    });
    
    return peers.slice(0, k);
  }
  
  // Distance XOR (Kademlia)
  xorDistance(id1, id2) {
    let distance = 0n;
    const hex1 = BigInt('0x' + id1);
    const hex2 = BigInt('0x' + id2);
    return hex1 ^ hex2;
  }
  
  // Envoyer un message via I2P
  async sendMessage(destination, message, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout'));
      }, timeout);
      
      try {
        this.i2pClient.send(destination, JSON.stringify(message), (err, response) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(JSON.parse(response));
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }
}

module.exports = DHTSearchEngine;
```

### 3. Serveur de Fichiers

**`file-server.js`**

```javascript
const fs = require('fs');
const path = require('path');

class FileServer {
  constructor(i2pClient, db, privateKey) {
    this.i2pClient = i2pClient;
    this.db = db;
    this.privateKey = privateKey;
    this.uploadSessions = new Map();
  }
  
  // Démarrer le serveur
  async start() {
    console.log('Démarrage du serveur de fichiers I2P...');
    
    // Écouter les connexions entrantes
    this.i2pClient.listen({
      privateKey: this.privateKey
    }, (err, stream) => {
      if (err) {
        console.error('Erreur écoute:', err);
        return;
      }
      
      console.log('Nouvelle connexion entrante');
      this.handleIncomingStream(stream);
    });
  }
  
  // Gérer une connexion entrante
  async handleIncomingStream(stream) {
    let buffer = '';
    
    stream.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      
      // Traiter les messages complets
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];  // Garder la dernière ligne partielle
      
      for (let i = 0; i < lines.length - 1; i++) {
        try {
          const message = JSON.parse(lines[i]);
          await this.handleMessage(stream, message);
        } catch (e) {
          console.error('Erreur parsing:', e);
          stream.end();
          return;
        }
      }
    });
    
    stream.on('end', () => {
      console.log('Connexion fermée');
    });
  }
  
  // Traiter un message
  async handleMessage(stream, message) {
    if (message.type === 'file_request') {
      await this.serveFile(stream, message);
    }
  }
  
  // Servir un fichier
  async serveFile(stream, request) {
    const { fileHash, range } = request;
    
    try {
      // Récupérer le fichier du hash
      const result = await new Promise((resolve, reject) => {
        this.db.get(
          'SELECT path FROM local_files WHERE hash = ? AND isShared = 1',
          [fileHash],
          (err, row) => {
            if (err) reject(err);
            else if (!row) reject(new Error('Fichier non trouvé'));
            else resolve(row);
          }
        );
      });
      
      // Envoyer le chunk demandé
      const fileStream = fs.createReadStream(result.path, {
        start: range.start,
        end: range.end
      });
      
      fileStream.pipe(stream, { end: false });
      
      fileStream.on('end', () => {
        stream.write('\n');  // Délimiteur
      });
      
    } catch (e) {
      console.error('Erreur servir fichier:', e);
      stream.write(JSON.stringify({ error: e.message }) + '\n');
      stream.end();
    }
  }
}

module.exports = FileServer;
```

### 4. Interface React

**`components/SearchResults.tsx`**

```typescript
import React, { useState, useEffect } from 'react';
import { useIPC } from '../hooks/useIPC';

interface FileResult {
  filename: string;
  fileHash: string;
  size: number;
  peerId: string;
  peerName: string;
}

export const SearchResults: React.FC<{ query: string }> = ({ query }) => {
  const [results, setResults] = useState<FileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const { invoke } = useIPC();
  
  useEffect(() => {
    const search = async () => {
      setLoading(true);
      try {
        const results = await invoke('search', query, {});
        setResults(results);
      } catch (e) {
        console.error('Erreur recherche:', e);
      } finally {
        setLoading(false);
      }
    };
    
    if (query.length > 2) {
      search();
    }
  }, [query, invoke]);
  
  const handleDownload = async (result: FileResult) => {
    try {
      await invoke('download', result.fileHash, result.peerId, result.filename);
      alert('Téléchargement ajouté à la queue');
    } catch (e) {
      alert('Erreur téléchargement: ' + e.message);
    }
  };
  
  return (
    <div className="search-results">
      {loading && <div className="loading">Recherche en cours...</div>}
      
      {results.map((result) => (
        <div key={result.fileHash} className="result-item">
          <div className="result-header">
            <h3>{result.filename}</h3>
            <span className="size">{formatBytes(result.size)}</span>
          </div>
          <div className="result-meta">
            <span className="peer">👤 {result.peerName}</span>
          </div>
          <button onClick={() => handleDownload(result)}>
            Télécharger
          </button>
        </div>
      ))}
    </div>
  );
};

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
```

---

## Plan de Développement

### Phase 1: Fondations (Semaines 1-4)

**Objectifs:**
- [x] Architecture Electron + Node.js
- [x] Intégration SAM I2P
- [x] Base de données SQLite
- [x] Scanner local de fichiers

**Livrables:**
- Prototype de démarrage
- Indexation locale en place
- Config persistante

### Phase 2: Réseau P2P (Semaines 5-8)

**Objectifs:**
- [x] Implémentation DHT Kademlia
- [x] Protocole de recherche distribué
- [x] Replication + TTL
- [x] Serveur de fichiers écoutant

**Livrables:**
- Recherche fonctionnelle
- Annonces de fichiers dans DHT
- Première découverte de peers

### Phase 3: Téléchargement (Semaines 9-12)

**Objectifs:**
- [x] Téléchargement multi-chunks
- [x] Parallélisation (4+ streams)
- [x] Vérification d'intégrité SHA256
- [x] Resume partiel

**Livrables:**
- Queue de téléchargement
- UI pour suivre progrès
- Gestion des erreurs

### Phase 4: UI/UX (Semaines 13-16)

**Objectifs:**
- [x] Interface React complète
- [x] Dark mode
- [x] Gestion des paramètres
- [x] Profil utilisateur

**Livrables:**
- App complètement fonctionnelle
- Cross-platform testing (Windows/macOS/Linux)

### Phase 5: Optimisations & Polissage (Semaines 17-20)

**Objectifs:**
- [x] Performance DHT
- [x] Caching intelligent
- [x] Notifications système
- [x] Auto-update

**Livrables:**
- Version 1.0 stable
- Installers pour 3 OS
- Documentation complète

---

## Fichiers à Créer

```
i2p-share/
├── src/
│   ├── main/
│   │   ├── main.ts                (Electron entry)
│   │   ├── preload.ts             (Security bridge)
│   │   ├── dht-search.ts          (Kademlia)
│   │   ├── file-server.ts         (Serveur fichiers)
│   │   ├── file-indexer.ts        (Scan local)
│   │   └── database.ts            (SQLite wrapper)
│   │
│   ├── renderer/
│   │   ├── App.tsx                (Root React)
│   │   ├── pages/
│   │   │   ├── Search.tsx
│   │   │   ├── Downloads.tsx
│   │   │   ├── MyShares.tsx
│   │   │   └── Settings.tsx
│   │   │
│   │   ├── components/
│   │   │   ├── SearchResults.tsx
│   │   │   ├── FileItem.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   └── PeerList.tsx
│   │   │
│   │   └── hooks/
│   │       ├── useIPC.ts
│   │       ├── useSearch.ts
│   │       └── useDownloads.ts
│   │
│   └── shared/
│       ├── types.ts               (TypeScript types)
│       ├── messages.ts            (Protocol defs)
│       └── config.ts
│
├── docker/
│   └── docker-compose.yml         (i2pd + app)
│
├── public/
│   ├── icon.png
│   └── index.html
│
├── schema.sql                      (DDL base de données)
├── package.json
├── tsconfig.json
├── webpack.config.js
└── README.md
```

---

## Configuration Docker

**docker-compose.yml**

```yaml
version: '3.8'

services:
  i2pd:
    image: purplei2p/i2pd:latest
    container_name: i2p_router
    ports:
      - "7656:7656"  # SAM API (localhost only)
      - "4444:4444"  # HTTP Proxy (optional)
    volumes:
      - ./i2pd_data:/home/i2pd/data
    environment:
      - SAM_ENABLED=true
    restart: unless-stopped
    networks:
      - i2p_network

  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: i2p_share_app
    depends_on:
      - i2pd
    environment:
      - SAM_HOST=i2pd
      - SAM_PORT=7656
      - NODE_ENV=production
    volumes:
      - ./config.json:/app/config.json
      - ./db:/app/db
    restart: unless-stopped
    networks:
      - i2p_network

networks:
  i2p_network:
    driver: bridge
```

---

## Sécurité

### Points d'Attention Critiques

1. **Clés Privées**
   - Jamais exposées via le réseau
   - Chiffrées au repos avec AES-256 + mot de passe utilisateur
   - Stockées dans `~/.i2p-share/config.json` (permissions 600)

2. **Connexions I2P**
   - Toutes les connexions passent par i2pd (sidecar)
   - IP réelle jamais exposée
   - Validation TLS optionnelle entre peers

3. **Intégrité des Fichiers**
   - Vérification SHA256 après téléchargement
   - Chunks signés optionnellement
   - Détection de corruption automatique

4. **Isolation Processus**
   - Electron: Main process (système) vs Renderer process (UI) isolés
   - IPC messages validés
   - No `nodeIntegration: true`

### Attaques Mitigées

| Attaque | Mitigation |
|---------|-----------|
| IP leak | I2P routing + tunnels onion |
| Poisoning de fichiers | SHA256 verification |
| DoS DHT | Rate limiting + bucket refresh |
| Man-in-the-middle | Chiffrement tunnel I2P |
| Sybil attack | Pas de mitigation (accepté par design) |

---

## Performance Estimée

**Métriques**

- **Recherche** : 1-3 secondes (5-10 sauts DHT)
- **Découverte de peers** : < 100 ms (local lookup)
- **Téléchargement** : 60-80% de clearnet (overhead chiffrage)
- **Latence réseau** : 2-5 secondes (vs <100ms TCP direct)
- **Mémoire RAM** : 300 MB (idle), 800 MB (10 downloads actifs)

**Bottlenecks Potentiels**

1. I2P tunnel setup (3-5 sec)
   → Mitigation: Tunnel pooling + persistent connections

2. DHT hops multiples
   → Mitigation: Caching local + meilleures heuristiques de routage

3. Chunks petits (256 KB) = overhead
   → Mitigation: Augmenter à 1 MB pour gros fichiers

---

## Références & Inspirations

- **Soulseek Protocol** [web:66][web:75]: Architecture peer + distributed search
- **I2P Documentation** [web:31][web:32]: Transport NTCP2/SSU2, NAT traversal
- **Electron Best Practices** [web:68][web:71][web:74]: Cross-platform desktop apps
- **Kademlia DHT** [web:36][web:45]: Distributed hash tables
- **Freenet WoT** [web:51][web:54]: Decentralized reputation (non implémenté ici)

---

## Conclusion

Ce système crée un **Soulseek ultra-décentralisé et anonyme** pour tout type de fichier, sans point de contrôle ni censure. Par rapport à Soulseek original :

✅ **Anonymat complet** (vs simple pseudonyme)
✅ **Tous les fichiers** (vs musique uniquement)
✅ **100% décentralisé** (vs serveur central)
✅ **Aucune censure** (vs contenu modéré)
✅ **Cross-platform natif** (vs limité)

⚠️ **Compromis acceptés** :
- Latence plus élevée (tunnels I2P)
- Moins de peers stables que Soulseek
- Pas de recommandations/reputation (par design)

---

**Prêt pour commencer l'implémentation ?**

Les prochaines étapes:
1. Créer la structure Electron
2. Intégrer i2pd en Docker
3. Implémenter DHT Kademlia
4. Construire le serveur de fichiers
5. Développer l'UI React

Bon codage ! 🚀