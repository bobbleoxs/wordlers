var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-IC7xCZ/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// .wrangler/tmp/bundle-IC7xCZ/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/worker.js
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/websocket") {
      return handleWebSocket(request, env);
    }
    if (url.pathname === "/") {
      return new Response(getGameHTML(), {
        headers: { "content-type": "text/html" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};
async function handleWebSocket(request, env) {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }
  const url = new URL(request.url);
  const roomCode = url.searchParams.get("room");
  if (!roomCode) {
    return new Response("Room code required", { status: 400 });
  }
  const id = env.GAME_ROOMS.idFromName(roomCode);
  const gameRoom = env.GAME_ROOMS.get(id);
  return gameRoom.fetch(request);
}
__name(handleWebSocket, "handleWebSocket");
var GameRoom = class {
  constructor(controller, env) {
    this.controller = controller;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.gameState = null;
  }
  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId") || this.generatePlayerId();
    const playerName = url.searchParams.get("playerName") || `Player ${playerId.substr(-4)}`;
    this.sessions.set(playerId, {
      webSocket: server,
      playerId,
      playerName,
      lastSeen: Date.now()
    });
    if (!this.gameState) {
      this.gameState = this.createNewGameData(url.searchParams.get("room"));
    }
    this.cleanupOldPlayers();
    this.gameState.players[playerId] = {
      name: playerName,
      lastSeen: Date.now(),
      online: true
    };
    this.sendToPlayer(playerId, {
      type: "gameState",
      gameState: this.gameState
    });
    this.broadcast({
      type: "playerJoined",
      playerId,
      playerName,
      players: this.gameState.players
    });
    server.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handleMessage(playerId, message);
      } catch (error) {
        console.error("Error handling message:", error);
        this.sendToPlayer(playerId, {
          type: "error",
          message: "Invalid message format"
        });
      }
    });
    server.addEventListener("close", () => {
      this.sessions.delete(playerId);
      if (this.gameState?.players[playerId]) {
        this.gameState.players[playerId].online = false;
      }
      this.broadcast({
        type: "playerLeft",
        playerId,
        players: this.gameState?.players || {}
      });
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  async handleMessage(playerId, message) {
    switch (message.type) {
      case "propose":
        await this.handleProposal(playerId, message.word);
        break;
      case "vote":
        await this.handleVote(playerId, message.agrees);
        break;
      case "heartbeat":
        this.updatePlayerPresence(playerId);
        break;
      default:
        console.log("Unknown message type:", message.type);
    }
  }
  async handleProposal(playerId, word) {
    if (!word || word.length !== 5) {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "Word must be exactly 5 letters"
      });
      return;
    }
    if (this.gameState.proposal) {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "Please vote on current proposal first"
      });
      return;
    }
    if (this.gameState.gameState !== "playing") {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "Game is not in playing state"
      });
      return;
    }
    this.gameState.proposal = {
      word: word.toUpperCase(),
      proposer: playerId,
      timestamp: Date.now()
    };
    this.gameState.votes = {};
    this.gameState.lastUpdate = Date.now();
    this.broadcast({
      type: "proposal",
      proposal: this.gameState.proposal,
      gameState: this.gameState
    });
  }
  async handleVote(playerId, agrees) {
    if (!this.gameState.proposal) {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "No proposal to vote on"
      });
      return;
    }
    this.gameState.votes[playerId] = agrees;
    this.gameState.lastUpdate = Date.now();
    this.broadcast({
      type: "vote",
      playerId,
      agrees,
      votes: this.gameState.votes
    });
    setTimeout(() => this.checkVotes(), 500);
  }
  checkVotes() {
    if (!this.gameState?.proposal)
      return;
    const votes = this.gameState.votes || {};
    const voteValues = Object.values(votes);
    const onlinePlayers = Object.keys(this.gameState.players).filter(
      (id) => this.gameState.players[id].online && this.sessions.has(id)
    );
    if (voteValues.length === 0)
      return;
    if (onlinePlayers.length === 1 || voteValues.length >= onlinePlayers.length) {
      const allAgree = voteValues.every((vote) => vote === true);
      if (allAgree) {
        this.submitWord(this.gameState.proposal.word);
      } else {
        this.rejectProposal();
      }
    }
  }
  submitWord(word) {
    const result = this.checkWord(word, this.gameState.targetWord);
    for (let i = 0; i < 5; i++) {
      this.gameState.board[this.gameState.currentRow][i] = word[i];
      this.gameState.boardStates[this.gameState.currentRow][i] = result[i];
    }
    if (word === this.gameState.targetWord) {
      this.gameState.gameState = "won";
    } else if (this.gameState.currentRow >= 5) {
      this.gameState.gameState = "lost";
    }
    this.gameState.currentRow++;
    this.gameState.proposal = null;
    this.gameState.votes = {};
    this.gameState.lastUpdate = Date.now();
    this.broadcast({
      type: "wordSubmitted",
      word,
      result,
      gameState: this.gameState
    });
  }
  rejectProposal() {
    this.gameState.proposal = null;
    this.gameState.votes = {};
    this.gameState.lastUpdate = Date.now();
    this.broadcast({
      type: "proposalRejected",
      gameState: this.gameState
    });
  }
  checkWord(word, targetWord) {
    const result = [];
    const targetLetters = targetWord.split("");
    const wordLetters = word.split("");
    for (let i = 0; i < 5; i++) {
      if (wordLetters[i] === targetLetters[i]) {
        result[i] = "correct";
        targetLetters[i] = null;
        wordLetters[i] = null;
      }
    }
    for (let i = 0; i < 5; i++) {
      if (wordLetters[i] !== null) {
        const index = targetLetters.indexOf(wordLetters[i]);
        if (index !== -1) {
          result[i] = "present";
          targetLetters[index] = null;
        } else {
          result[i] = "absent";
        }
      }
    }
    return result;
  }
  createNewGameData(roomCode) {
    const words = ["HELLO", "WORLD", "GAMES", "MUSIC", "DANCE", "PARTY", "LIGHT", "SMILE", "HAPPY", "PEACE"];
    const today = (/* @__PURE__ */ new Date()).toDateString();
    const seed = this.hashCode(today + roomCode);
    const targetWord = words[Math.abs(seed) % words.length];
    return {
      roomCode,
      targetWord,
      currentRow: 0,
      gameState: "playing",
      board: Array(6).fill().map(() => Array(5).fill("")),
      boardStates: Array(6).fill().map(() => Array(5).fill("")),
      proposal: null,
      votes: {},
      players: {},
      createdAt: Date.now(),
      lastUpdate: Date.now()
    };
  }
  updatePlayerPresence(playerId) {
    if (this.gameState?.players[playerId]) {
      this.gameState.players[playerId].lastSeen = Date.now();
    }
  }
  cleanupOldPlayers() {
    if (!this.gameState?.players)
      return;
    const now = Date.now();
    Object.keys(this.gameState.players).forEach((id) => {
      if (now - this.gameState.players[id].lastSeen > 12e4) {
        delete this.gameState.players[id];
      }
    });
  }
  sendToPlayer(playerId, message) {
    const session = this.sessions.get(playerId);
    if (session?.webSocket) {
      try {
        session.webSocket.send(JSON.stringify(message));
      } catch (error) {
        console.error("Failed to send to player:", error);
        this.sessions.delete(playerId);
      }
    }
  }
  broadcast(message) {
    for (const [playerId] of this.sessions) {
      this.sendToPlayer(playerId, message);
    }
  }
  generatePlayerId() {
    return "player_" + Math.random().toString(36).substr(2, 9);
  }
  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash;
  }
};
__name(GameRoom, "GameRoom");
function getGameHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Wordle Together - Real-time Multiplayer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 10px;
            margin: 0;
        }

        .game-container {
            background: white;
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 100%;
            min-height: calc(100vh - 20px);
            display: flex;
            flex-direction: column;
        }

        .header {
            text-align: center;
            margin-bottom: 20px;
        }

        .title {
            font-size: 2rem;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .subtitle {
            color: #666;
            font-size: 0.9rem;
        }

        .connection-status {
            margin: 15px 0;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
            font-size: 0.85rem;
            font-weight: 500;
        }

        .connection-status.connecting {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }

        .connection-status.connected {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }

        .connection-status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }

        .room-info {
            margin: 10px 0;
            padding: 12px;
            background: #f8f9fa;
            border-radius: 8px;
            text-align: center;
            border: 2px dashed #6c757d;
        }

        .room-code {
            font-size: 1.5rem;
            font-weight: bold;
            color: #495057;
            letter-spacing: 3px;
            margin: 5px 0;
        }

        .players-online {
            margin: 10px 0;
            padding: 10px;
            background: #e8f4fd;
            border-radius: 8px;
            text-align: center;
            font-size: 0.85rem;
        }

        .game-board {
            display: grid;
            grid-template-rows: repeat(6, 1fr);
            gap: 5px;
            margin: 20px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
        }

        .row {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 5px;
        }

        .cell {
            width: 50px;
            height: 50px;
            border: 2px solid #d3d6da;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 1.5rem;
            font-weight: bold;
            color: #fff;
            text-transform: uppercase;
            transition: all 0.3s ease;
            border-radius: 4px;
        }

        .cell.filled {
            border-color: #878a8c;
            background-color: #878a8c;
        }

        .cell.correct {
            background-color: #6aaa64;
            border-color: #6aaa64;
        }

        .cell.present {
            background-color: #c9b458;
            border-color: #c9b458;
        }

        .cell.absent {
            background-color: #787c7e;
            border-color: #787c7e;
        }

        .cell.proposed {
            background-color: #85c1e9;
            border-color: #3498db;
            animation: pulse 1.5s ease-in-out infinite alternate;
        }

        @keyframes pulse {
            from { opacity: 0.7; }
            to { opacity: 1; }
        }

        .controls {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
        }

        .input-container {
            flex: 1;
            position: relative;
        }

        .word-input {
            width: 100%;
            padding: 15px 20px;
            font-size: 1.2rem;
            border: 2px solid #d3d6da;
            border-radius: 8px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            transition: border-color 0.3s ease;
        }

        .word-input:focus {
            outline: none;
            border-color: #6aaa64;
        }

        .voting-buttons {
            display: flex;
            gap: 10px;
        }

        .vote-btn {
            width: 50px;
            height: 50px;
            border: none;
            border-radius: 8px;
            font-size: 1.5rem;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .vote-btn:hover:not(:disabled) {
            transform: translateY(-2px);
        }

        .propose-btn {
            background: #3498db;
            color: white;
        }

        .propose-btn:hover:not(:disabled) {
            background: #2980b9;
        }

        .agree-btn {
            background: #27ae60;
            color: white;
        }

        .agree-btn:hover:not(:disabled) {
            background: #229954;
        }

        .disagree-btn {
            background: #e74c3c;
            color: white;
        }

        .disagree-btn:hover:not(:disabled) {
            background: #c0392b;
        }

        .vote-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .status {
            text-align: center;
            padding: 15px;
            margin: 20px 0;
            border-radius: 8px;
            font-weight: 500;
        }

        .status.waiting {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }

        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }

        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }

        .status.proposal {
            background: #cce5ff;
            color: #004085;
            border: 1px solid #85c1e9;
        }

        @media (max-width: 600px) {
            .cell {
                width: 45px;
                height: 45px;
                font-size: 1.3rem;
            }
            
            .game-container {
                padding: 15px;
                margin: 5px;
            }
            
            .title {
                font-size: 1.8rem;
            }
            
            .vote-btn {
                width: 45px;
                height: 45px;
                font-size: 1.3rem;
            }
            
            .word-input {
                font-size: 1.1rem;
                padding: 12px 15px;
            }
        }
    </style>
</head>
<body>
    <div class="game-container">
        <div class="header">
            <h1 class="title">Wordle Together</h1>
            <p class="subtitle">Real-time collaborative word guessing</p>
        </div>

        <div class="connection-status connecting" id="connectionStatus">
            Connecting to game server...
        </div>

        <div class="room-info">
            <div style="font-size: 0.9rem; margin-bottom: 5px;">\u{1F4A1} Share this URL with your partner!</div>
            <div class="room-code" id="roomCode"></div>
            <div style="font-size: 0.75rem; color: #666; margin-top: 5px;">
                \u{1F30D} <strong>True real-time sync across devices!</strong><br>
                Proposals and votes appear instantly.
            </div>
        </div>

        <div class="players-online" id="playersOnline">
            Checking for players...
        </div>

        <div class="game-board" id="gameBoard">
            <!-- Grid will be generated by JavaScript -->
        </div>

        <div class="status" id="status">Connecting to game...</div>

        <div class="controls">
            <div class="input-container">
                <input type="text" class="word-input" id="wordInput" maxlength="5" placeholder="Enter word..." disabled>
            </div>
            <div class="voting-buttons">
                <button class="vote-btn propose-btn" id="proposeBtn" title="Propose this word" disabled>?</button>
                <button class="vote-btn agree-btn" id="agreeBtn" title="Agree with proposal" disabled>\u2713</button>
                <button class="vote-btn disagree-btn" id="disagreeBtn" title="Disagree with proposal" disabled>\u2717</button>
            </div>
        </div>
    </div>

    <script>
        class CollaborativeWordle {
            constructor() {
                this.roomCode = this.getRoomCode();
                this.playerId = this.generatePlayerId();
                this.playerName = \`Player \${this.playerId.substr(-4)}\`;
                this.ws = null;
                this.gameState = null;
                this.reconnectAttempts = 0;
                this.maxReconnectAttempts = 5;
                
                this.initializeGame();
                this.setupEventListeners();
                this.connect();
            }

            getRoomCode() {
                let roomCode = window.location.hash.substr(1);
                if (!roomCode) {
                    roomCode = Math.random().toString(36).substr(2, 6).toUpperCase();
                    window.location.hash = roomCode;
                }
                document.getElementById('roomCode').textContent = roomCode;
                return roomCode;
            }

            generatePlayerId() {
                return 'player_' + Math.random().toString(36).substr(2, 9);
            }

            connect() {
                this.updateConnectionStatus('connecting', '\u{1F504} Connecting to game server...');
                
                const wsUrl = \`\${location.protocol === 'https:' ? 'wss:' : 'ws:'}\${location.host}/websocket?room=\${this.roomCode}&playerId=\${this.playerId}&playerName=\${encodeURIComponent(this.playerName)}\`;
                
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    this.updateConnectionStatus('connected', '\u2705 Connected - real-time sync active!');
                    this.enableControls();
                    this.reconnectAttempts = 0;
                    
                    // Send heartbeat every 30 seconds
                    this.heartbeatInterval = setInterval(() => {
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ type: 'heartbeat' }));
                        }
                    }, 30000);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Failed to parse message:', error);
                    }
                };

                this.ws.onclose = () => {
                    this.updateConnectionStatus('error', '\u274C Connection lost - reconnecting...');
                    this.disableControls();
                    
                    if (this.heartbeatInterval) {
                        clearInterval(this.heartbeatInterval);
                    }
                    
                    // Attempt to reconnect
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        setTimeout(() => this.connect(), Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000));
                    } else {
                        this.updateConnectionStatus('error', '\u274C Connection failed - please refresh');
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                };
            }

            handleMessage(message) {
                switch (message.type) {
                    case 'gameState':
                        this.gameState = message.gameState;
                        this.updateUI();
                        break;
                    case 'proposal':
                        this.gameState = message.gameState;
                        this.updateUI();
                        break;
                    case 'vote':
                        this.gameState.votes = message.votes;
                        this.updateUI();
                        break;
                    case 'wordSubmitted':
                        this.gameState = message.gameState;
                        this.updateUI();
                        break;
                    case 'proposalRejected':
                        this.gameState = message.gameState;
                        this.updateUI();
                        this.updateStatus('Proposal rejected. Try another word!', 'error');
                        break;
                    case 'playerJoined':
                    case 'playerLeft':
                        if (this.gameState) {
                            this.gameState.players = message.players;
                            this.updatePlayersDisplay();
                        }
                        break;
                    case 'error':
                        this.updateStatus(message.message, 'error');
                        break;
                }
            }

            updateUI() {
                if (!this.gameState) return;

                this.updatePlayersDisplay();
                this.updateGameBoard();
                this.updateProposalState();
                this.updateGameStatus();
            }

            updatePlayersDisplay() {
                const players = this.gameState?.players || {};
                const onlinePlayers = Object.values(players).filter(p => p.online);
                
                const playersEl = document.getElementById('playersOnline');
                if (onlinePlayers.length === 0) {
                    playersEl.textContent = 'No players detected';
                } else if (onlinePlayers.length === 1) {
                    playersEl.textContent = '\u{1F464} 1 player online (waiting for partner)';
                } else {
                    playersEl.textContent = \`\u{1F465} \${onlinePlayers.length} players online - Ready to collaborate!\`;
                }
            }

            updateGameBoard() {
                for (let i = 0; i < 6; i++) {
                    for (let j = 0; j < 5; j++) {
                        const cell = document.getElementById(\`cell-\${i}-\${j}\`);
                        const letter = this.gameState.board[i][j];
                        const state = this.gameState.boardStates[i][j];
                        
                        cell.textContent = letter;
                        cell.className = 'cell';
                        if (letter && state) {
                            cell.classList.add('filled', state);
                        }
                    }
                }

                // Show current proposal
                if (this.gameState.proposal) {
                    this.showProposal(this.gameState.proposal.word, this.gameState.currentRow);
                }
            }

            updateProposalState() {
                const proposal = this.gameState?.proposal;
                if (proposal) {
                    const isMyProposal = proposal.proposer === this.playerId;
                    const myVote = this.gameState.votes[this.playerId];
                    const proposerName = this.gameState.players[proposal.proposer]?.name || 'Someone';
                    
                    if (isMyProposal) {
                        this.updateStatus(\`You proposed: "\${proposal.word}". Waiting for partner's vote...\`, 'proposal');
                    } else {
                        this.updateStatus(\`\${proposerName} proposed: "\${proposal.word}". Vote now!\`, 'proposal');
                    }

                    this.updateButtons(false, !myVote, !myVote);
                } else {
                    this.updateStatus('Enter a 5-letter word and propose it to your partner!');
                    this.updateButtons(true, false, false);
                }
            }

            updateGameStatus() {
                if (this.gameState?.gameState === 'won') {
                    this.updateStatus(\`\u{1F389} Congratulations! You found the word: "\${this.gameState.targetWord}"!\`, 'success');
                    this.updateButtons(false, false, false);
                } else if (this.gameState?.gameState === 'lost') {
                    this.updateStatus(\`\u{1F614} Game over! The word was: "\${this.gameState.targetWord}"\`, 'error');
                    this.updateButtons(false, false, false);
                }
            }

            enableControls() {
                document.getElementById('wordInput').disabled = false;
                document.getElementById('proposeBtn').disabled = false;
            }

            disableControls() {
                document.getElementById('wordInput').disabled = true;
                document.getElementById('proposeBtn').disabled = true;
                document.getElementById('agreeBtn').disabled = true;
                document.getElementById('disagreeBtn').disabled = true;
            }

            initializeGame() {
                this.createGameBoard();
            }

            createGameBoard() {
                const board = document.getElementById('gameBoard');
                board.innerHTML = '';
                
                for (let i = 0; i < 6; i++) {
                    const row = document.createElement('div');
                    row.className = 'row';
                    
                    for (let j = 0; j < 5; j++) {
                        const cell = document.createElement('div');
                        cell.className = 'cell';
                        cell.id = \`cell-\${i}-\${j}\`;
                        row.appendChild(cell);
                    }
                    
                    board.appendChild(row);
                }
            }

            setupEventListeners() {
                const wordInput = document.getElementById('wordInput');
                const proposeBtn = document.getElementById('proposeBtn');
                const agreeBtn = document.getElementById('agreeBtn');
                const disagreeBtn = document.getElementById('disagreeBtn');

                wordInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
                });

                wordInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        this.proposeWord();
                    }
                });

                proposeBtn.addEventListener('click', () => this.proposeWord());
                agreeBtn.addEventListener('click', () => this.vote(true));
                disagreeBtn.addEventListener('click', () => this.vote(false));
            }

            proposeWord() {
                const input = document.getElementById('wordInput');
                const word = input.value.trim();

                if (word.length !== 5) {
                    this.updateStatus('Word must be exactly 5 letters!', 'error');
                    return;
                }

                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'propose',
                        word: word
                    }));
                    input.value = '';
                } else {
                    this.updateStatus('Not connected to server', 'error');
                }
            }

            vote(agrees) {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'vote',
                        agrees: agrees
                    }));
                } else {
                    this.updateStatus('Not connected to server', 'error');
                }
            }

            showProposal(word, row) {
                // Clear existing proposals first
                document.querySelectorAll('.cell.proposed').forEach(cell => {
                    cell.classList.remove('proposed');
                });

                // Show new proposal
                for (let i = 0; i < 5; i++) {
                    const cell = document.getElementById(\`cell-\${row}-\${i}\`);
                    if (cell) {
                        cell.textContent = word[i];
                        cell.classList.add('proposed');
                    }
                }
            }

            updateButtons(propose, agree, disagree) {
                document.getElementById('proposeBtn').disabled = !propose;
                document.getElementById('agreeBtn').disabled = !agree;
                document.getElementById('disagreeBtn').disabled = !disagree;
            }

            updateStatus(message, type = '') {
                const status = document.getElementById('status');
                status.textContent = message;
                status.className = \`status \${type}\`;
            }

            updateConnectionStatus(status, message) {
                const statusEl = document.getElementById('connectionStatus');
                statusEl.className = \`connection-status \${status}\`;
                statusEl.textContent = message;
            }
        }

        // Initialize the game when page loads
        window.addEventListener('DOMContentLoaded', () => {
            new CollaborativeWordle();
        });
    <\/script>
</body>
</html>`;
}
__name(getGameHTML, "getGameHTML");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-IC7xCZ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-IC7xCZ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GameRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
