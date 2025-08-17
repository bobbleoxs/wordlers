export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/websocket') {
      return handleWebSocket(request, env);
    }
    
    if (url.pathname === '/') {
      return new Response(getGameHTML(), {
        headers: { 'content-type': 'text/html' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
};

async function handleWebSocket(request, env) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const url = new URL(request.url);
  const roomCode = url.searchParams.get('room');
  
  if (!roomCode) {
    return new Response('Room code required', { status: 400 });
  }

  // Get Durable Object instance for this room
  const id = env.GAME_ROOMS.idFromName(roomCode);
  const gameRoom = env.GAME_ROOMS.get(id);
  
  return gameRoom.fetch(request);
}

export class GameRoom {
  constructor(controller, env) {
    this.controller = controller;
    this.env = env;
    this.sessions = new Map();
    this.gameState = null;
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId') || this.generatePlayerId();
    const playerName = url.searchParams.get('playerName') || `Player ${playerId.substr(-4)}`;
    
    // Store session
    this.sessions.set(playerId, {
      webSocket: server,
      playerId,
      playerName,
      lastSeen: Date.now()
    });

    // Initialize game state if needed
    if (!this.gameState) {
      this.gameState = this.createNewGameData(url.searchParams.get('room'));
    }

    // Clean up old players
    this.cleanupOldPlayers();
    
    // Add player to game
    this.gameState.players[playerId] = {
      name: playerName,
      lastSeen: Date.now(),
      online: true
    };

    // Send initial game state
    this.sendToPlayer(playerId, {
      type: 'gameState',
      gameState: this.gameState
    });

    // Broadcast player joined
    this.broadcast({
      type: 'playerJoined',
      playerId,
      playerName,
      players: this.gameState.players
    });

    // Handle WebSocket events
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handleMessage(playerId, message);
      } catch (error) {
        console.error('Error handling message:', error);
        this.sendToPlayer(playerId, {
          type: 'error',
          message: 'Invalid message format'
        });
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(playerId);
      if (this.gameState?.players[playerId]) {
        this.gameState.players[playerId].online = false;
      }
      this.broadcast({
        type: 'playerLeft',
        playerId,
        players: this.gameState?.players || {}
      });
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleMessage(playerId, message) {
    switch (message.type) {
      case 'propose':
        await this.handleProposal(playerId, message.word);
        break;
      case 'vote':
        await this.handleVote(playerId, message.agrees);
        break;
      case 'heartbeat':
        this.updatePlayerPresence(playerId);
        break;
      default:
        console.log('Unknown message type:', message.type);
    }
  }

  async handleProposal(playerId, word) {
    if (!word || word.length !== 5) {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: 'Word must be exactly 5 letters'
      });
      return;
    }

    // Validate word exists in English dictionary
    if (!this.isValidWord(word.toUpperCase())) {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: `"${word.toUpperCase()}" is not a valid English word`
      });
      return;
    }

    if (this.gameState.proposal) {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: 'Please vote on current proposal first'
      });
      return;
    }

    if (this.gameState.gameState !== 'playing') {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: 'Game is not in playing state'
      });
      return;
    }

    // Create proposal
    this.gameState.proposal = {
      word: word.toUpperCase(),
      proposer: playerId,
      timestamp: Date.now()
    };
    this.gameState.votes = {};
    this.gameState.lastUpdate = Date.now();

    this.broadcast({
      type: 'proposal',
      proposal: this.gameState.proposal,
      gameState: this.gameState
    });
  }

  async handleVote(playerId, agrees) {
    if (!this.gameState.proposal) {
      this.sendToPlayer(playerId, {
        type: 'error',
        message: 'No proposal to vote on'
      });
      return;
    }

    this.gameState.votes[playerId] = agrees;
    this.gameState.lastUpdate = Date.now();

    this.broadcast({
      type: 'vote',
      playerId,
      agrees,
      votes: this.gameState.votes
    });

    // Check if we should process the proposal
    setTimeout(() => this.checkVotes(), 500);
  }

  checkVotes() {
    if (!this.gameState?.proposal) return;

    const votes = this.gameState.votes || {};
    const voteValues = Object.values(votes);
    const onlinePlayers = Object.keys(this.gameState.players).filter(id => 
      this.gameState.players[id].online && this.sessions.has(id)
    );

    // Need at least one vote
    if (voteValues.length === 0) return;
    
    // If only one player online, auto-approve
    // If all NON-PROPOSER players have voted, process the result
    const nonProposerPlayers = onlinePlayers.filter(id => id !== this.gameState.proposal.proposer);
    
    if (onlinePlayers.length === 1 || voteValues.length >= nonProposerPlayers.length) {
      const allAgree = voteValues.every(vote => vote === true);
      
      if (allAgree) {
        this.submitWord(this.gameState.proposal.word);
      } else {
        this.rejectProposal();
      }
    }
  }

  submitWord(word) {
    const result = this.checkWord(word, this.gameState.targetWord);

    // Update board
    for (let i = 0; i < 5; i++) {
      this.gameState.board[this.gameState.currentRow][i] = word[i];
      this.gameState.boardStates[this.gameState.currentRow][i] = result[i];
    }

    // Check win/lose conditions
    if (word === this.gameState.targetWord) {
      this.gameState.gameState = 'won';
    } else if (this.gameState.currentRow >= 5) {
      this.gameState.gameState = 'lost';
    }

    this.gameState.currentRow++;
    this.gameState.proposal = null;
    this.gameState.votes = {};
    this.gameState.lastUpdate = Date.now();

    this.broadcast({
      type: 'wordSubmitted',
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
      type: 'proposalRejected',
      gameState: this.gameState
    });
  }

  checkWord(word, targetWord) {
    const result = [];
    const targetLetters = targetWord.split('');
    const wordLetters = word.split('');
    
    // First pass: mark correct positions
    for (let i = 0; i < 5; i++) {
      if (wordLetters[i] === targetLetters[i]) {
        result[i] = 'correct';
        targetLetters[i] = null;
        wordLetters[i] = null;
      }
    }
    
    // Second pass: mark present letters
    for (let i = 0; i < 5; i++) {
      if (wordLetters[i] !== null) {
        const index = targetLetters.indexOf(wordLetters[i]);
        if (index !== -1) {
          result[i] = 'present';
          targetLetters[index] = null;
        } else {
          result[i] = 'absent';
        }
      }
    }
    
    return result;
  }

  createNewGameData(roomCode) {
    const words = ['HELLO', 'WORLD', 'GAMES', 'MUSIC', 'DANCE', 'PARTY', 'LIGHT', 'SMILE', 'HAPPY', 'PEACE'];
    const today = new Date().toDateString();
    const seed = this.hashCode(today + roomCode);
    const targetWord = words[Math.abs(seed) % words.length];

    return {
      roomCode,
      targetWord,
      currentRow: 0,
      gameState: 'playing',
      board: Array(6).fill().map(() => Array(5).fill('')),
      boardStates: Array(6).fill().map(() => Array(5).fill('')),
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
    if (!this.gameState?.players) return;
    
    const now = Date.now();
    Object.keys(this.gameState.players).forEach(id => {
      if (now - this.gameState.players[id].lastSeen > 120000) { // 2 minutes
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
        console.error('Failed to send to player:', error);
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
    return 'player_' + Math.random().toString(36).substr(2, 9);
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  isValidWord(word) {
    // Comprehensive 5-letter words for Wordle (1000+ common words)
    const validWords = new Set([
      'ABOUT', 'ABOVE', 'ABUSE', 'ACTOR', 'ACUTE', 'ADMIT', 'ADOPT', 'ADULT', 'AFTER', 'AGAIN',
      'AGENT', 'AGREE', 'AHEAD', 'ALARM', 'ALBUM', 'ALERT', 'ALIEN', 'ALIGN', 'ALIKE', 'ALIVE',
      'ALLOW', 'ALONE', 'ALONG', 'ALTER', 'ANGER', 'ANGLE', 'ANGRY', 'APART', 'APPLE', 'APPLY',
      'ARENA', 'ARGUE', 'ARISE', 'ARRAY', 'ASIDE', 'ASSET', 'AUDIO', 'AUDIT', 'AVOID', 'AWAKE',
      'AWARD', 'AWARE', 'BADLY', 'BASIC', 'BEACH', 'BEGAN', 'BEGIN', 'BEING', 'BELOW', 'BENCH',
      'BIRTH', 'BLACK', 'BLAME', 'BLANK', 'BLAST', 'BLIND', 'BLOCK', 'BLOOD', 'BOARD', 'BOOST',
      'BOOTH', 'BOUND', 'BRAIN', 'BRAND', 'BRAVE', 'BREAD', 'BREAK', 'BREED', 'BRIEF', 'BRING',
      'BROAD', 'BROKE', 'BROWN', 'BUILD', 'BUILT', 'BUYER', 'CABLE', 'CARRY', 'CATCH', 'CAUSE',
      'CHAIN', 'CHAIR', 'CHAOS', 'CHARM', 'CHART', 'CHASE', 'CHEAP', 'CHECK', 'CHEST', 'CHIEF',
      'CHILD', 'CHINA', 'CHOSE', 'CIVIL', 'CLAIM', 'CLASS', 'CLEAN', 'CLEAR', 'CLICK', 'CLIMB',
      'CLOCK', 'CLOSE', 'CLOUD', 'COACH', 'COAST', 'COULD', 'COUNT', 'COURT', 'COVER', 'CRAFT',
      'CRASH', 'CRAZY', 'CREAM', 'CRIME', 'CROSS', 'CROWD', 'CROWN', 'CRUDE', 'CURVE', 'CYCLE',
      'DAILY', 'DANCE', 'DATED', 'DEALT', 'DEATH', 'DEBUT', 'DELAY', 'DEPTH', 'DOING', 'DOUBT',
      'DOZEN', 'DRAFT', 'DRAMA', 'DRANK', 'DREAM', 'DRESS', 'DRILL', 'DRINK', 'DRIVE', 'DROVE',
      'DYING', 'EAGER', 'EARLY', 'EARTH', 'EIGHT', 'ELITE', 'EMPTY', 'ENEMY', 'ENJOY', 'ENTER',
      'ENTRY', 'EQUAL', 'ERROR', 'EVENT', 'EVERY', 'EXACT', 'EXIST', 'EXTRA', 'FAITH', 'FALSE',
      'FAULT', 'FIBER', 'FIELD', 'FIFTH', 'FIFTY', 'FIGHT', 'FINAL', 'FIRST', 'FIXED', 'FLASH',
      'FLEET', 'FLOOR', 'FLUID', 'FOCUS', 'FORCE', 'FORTH', 'FORTY', 'FORUM', 'FOUND', 'FRAME',
      'FRANK', 'FRAUD', 'FRESH', 'FRONT', 'FRUIT', 'FULLY', 'FUNNY', 'GIANT', 'GIVEN', 'GLASS',
      'GLOBE', 'GOING', 'GRACE', 'GRADE', 'GRAND', 'GRANT', 'GRASS', 'GRAVE', 'GREAT', 'GREEN',
      'GROSS', 'GROUP', 'GROWN', 'GUARD', 'GUESS', 'GUEST', 'GUIDE', 'HAPPY', 'HEART', 'HEAVY',
      'HENCE', 'HORSE', 'HOTEL', 'HOUSE', 'HUMAN', 'HURRY', 'IMAGE', 'INDEX', 'INNER', 'INPUT',
      'ISSUE', 'JOINT', 'JUDGE', 'KNOWN', 'LABEL', 'LARGE', 'LASER', 'LATER', 'LAUGH', 'LAYER',
      'LEARN', 'LEASE', 'LEAST', 'LEAVE', 'LEGAL', 'LEVEL', 'LIGHT', 'LIMIT', 'LINKS', 'LIVES',
      'LOCAL', 'LOOSE', 'LOWER', 'LUCKY', 'LUNCH', 'LYING', 'MAGIC', 'MAJOR', 'MAKER', 'MARCH',
      'MATCH', 'MAYBE', 'MAYOR', 'MEANT', 'MEDIA', 'METAL', 'MIGHT', 'MINOR', 'MINUS', 'MIXED',
      'MODEL', 'MONEY', 'MONTH', 'MORAL', 'MOTOR', 'MOUNT', 'MOUSE', 'MOUTH', 'MOVED', 'MOVIE',
      'MUSIC', 'NEEDS', 'NEVER', 'NEWLY', 'NIGHT', 'NOISE', 'NORTH', 'NOTED', 'NOVEL', 'NURSE',
      'OCCUR', 'OCEAN', 'OFFER', 'OFTEN', 'ORDER', 'OTHER', 'OUGHT', 'PAINT', 'PANEL', 'PAPER',
      'PARTY', 'PEACE', 'PHASE', 'PHONE', 'PHOTO', 'PIANO', 'PIECE', 'PILOT', 'PITCH', 'PLACE',
      'PLAIN', 'PLANE', 'PLANT', 'PLATE', 'POINT', 'POUND', 'POWER', 'PRESS', 'PRICE', 'PRIDE',
      'PRIME', 'PRINT', 'PRIOR', 'PRIZE', 'PROOF', 'PROUD', 'PROVE', 'QUEEN', 'QUICK', 'QUIET',
      'QUITE', 'RADIO', 'RAISE', 'RANGE', 'RAPID', 'RATIO', 'REACH', 'READY', 'REALM', 'REBEL',
      'REFER', 'RELAX', 'REPAY', 'REPLY', 'RIGHT', 'RIVAL', 'RIVER', 'ROUGH', 'ROUND', 'ROUTE',
      'ROYAL', 'RURAL', 'SCALE', 'SCENE', 'SCOPE', 'SCORE', 'SENSE', 'SERVE', 'SETUP', 'SEVEN',
      'SHALL', 'SHAPE', 'SHARE', 'SHARP', 'SHEET', 'SHELF', 'SHELL', 'SHIFT', 'SHINE', 'SHIRT',
      'SHOCK', 'SHOOT', 'SHORT', 'SHOWN', 'SIGHT', 'SILLY', 'SINCE', 'SIXTH', 'SIXTY', 'SIZED',
      'SKILL', 'SLEEP', 'SLIDE', 'SMALL', 'SMART', 'SMILE', 'SMOKE', 'SOLID', 'SOLVE', 'SORRY',
      'SOUND', 'SOUTH', 'SPACE', 'SPARE', 'SPEAK', 'SPEED', 'SPEND', 'SPENT', 'SPLIT', 'SPOKE',
      'SPORT', 'STAFF', 'STAGE', 'STAKE', 'STAND', 'START', 'STATE', 'STEAM', 'STEEL', 'STICK',
      'STILL', 'STOCK', 'STONE', 'STOOD', 'STORE', 'STORM', 'STORY', 'STRIP', 'STUCK', 'STUDY',
      'STUFF', 'STYLE', 'SUGAR', 'SUITE', 'SUPER', 'SWEET', 'TABLE', 'TAKEN', 'TASTE', 'TAXES',
      'TEACH', 'TEENS', 'TEETH', 'THANK', 'THEFT', 'THEIR', 'THEME', 'THERE', 'THESE', 'THICK',
      'THING', 'THINK', 'THIRD', 'THOSE', 'THREE', 'THREW', 'THROW', 'THUMB', 'TIGER', 'TIGHT',
      'TIMES', 'TIRED', 'TITLE', 'TODAY', 'TOKEN', 'TOTAL', 'TOUCH', 'TOUGH', 'TOWER', 'TRACK',
      'TRADE', 'TRAIL', 'TRAIN', 'TRAIT', 'TREAT', 'TREND', 'TRIAL', 'TRIBE', 'TRICK', 'TRIED',
      'TRIES', 'TRUCK', 'TRULY', 'TRUNK', 'TRUST', 'TRUTH', 'TWICE', 'TWIST', 'ULTRA', 'UNCLE',
      'UNDER', 'UNDUE', 'UNION', 'UNITY', 'UNTIL', 'UPPER', 'UPSET', 'URBAN', 'USAGE', 'USUAL',
      'VALUE', 'VIDEO', 'VIRUS', 'VISIT', 'VITAL', 'VOCAL', 'VOICE', 'WASTE', 'WATCH', 'WATER',
      'WAVES', 'WEIRD', 'WHALE', 'WHEAT', 'WHEEL', 'WHERE', 'WHICH', 'WHILE', 'WHITE', 'WHOLE',
      'WHOSE', 'WOMAN', 'WOMEN', 'WORLD', 'WORRY', 'WORSE', 'WORST', 'WORTH', 'WOULD', 'WRITE',
      'WRONG', 'WROTE', 'YOUNG', 'YOUTH', 'YOURS',
      // Additional common words including the ones you mentioned
      'ABOUT', 'ABOVE', 'ABUSE', 'ACTOR', 'ACUTE', 'ADMIT', 'ADOPT', 'ADULT', 'AFTER', 'AGAIN',
      'AGENT', 'AGREE', 'AHEAD', 'ALARM', 'ALBUM', 'ALERT', 'ALIEN', 'ALIGN', 'ALIKE', 'ALIVE',
      'ALLOW', 'ALONE', 'ALONG', 'ALTER', 'ANGER', 'ANGLE', 'ANGRY', 'APART', 'APPLE', 'APPLY',
      'ARENA', 'ARGUE', 'ARISE', 'ARRAY', 'ASIDE', 'ASSET', 'ATLAS', 'AVOID', 'AWAKE', 'AWARD',
      'AWARE', 'BADGE', 'BADLY', 'BAGEL', 'BAKER', 'BALLS', 'BANDS', 'BANKS', 'BARNS', 'BASED',
      'BASIC', 'BATCH', 'BEACH', 'BEANS', 'BEARS', 'BEAST', 'BEGAN', 'BEGIN', 'BEING', 'BELLS',
      'BELLY', 'BELOW', 'BENCH', 'BIKES', 'BILLS', 'BIRDS', 'BIRTH', 'BLACK', 'BLADE', 'BLAME',
      'BLANK', 'BLAST', 'BLEND', 'BLIND', 'BLOCK', 'BLOOD', 'BLOWN', 'BLUES', 'BOARD', 'BOATS',
      'BONES', 'BOOST', 'BOOTH', 'BOOTS', 'BOUND', 'BOXES', 'BRAIN', 'BRAKE', 'BRAND', 'BRASS',
      'BRAVE', 'BREAD', 'BREAK', 'BREED', 'BRICK', 'BRIDE', 'BRIEF', 'BRING', 'BROAD', 'BROKE',
      'BROWN', 'BRUSH', 'BUILD', 'BUILT', 'BUNCH', 'BUYER', 'CABLE', 'CAKES', 'CAMPS', 'CANDY',
      'CARDS', 'CARRY', 'CATCH', 'CAUSE', 'CAVES', 'CHAIN', 'CHAIR', 'CHAOS', 'CHARM', 'CHART',
      'CHASE', 'CHEAP', 'CHECK', 'CHESS', 'CHEST', 'CHIEF', 'CHILD', 'CHINA', 'CHIPS', 'CHOSE',
      'CIVIL', 'CLAIM', 'CLASS', 'CLEAN', 'CLEAR', 'CLICK', 'CLIMB', 'CLOCK', 'CLOSE', 'CLOTH',
      'CLOUD', 'CLUBS', 'COACH', 'COAST', 'COATS', 'CODES', 'COINS', 'COLOR', 'COMES', 'COMIC',
      'CORAL', 'COSTS', 'COULD', 'COUNT', 'COURT', 'COVER', 'CRAFT', 'CRASH', 'CRAZY', 'CREAM',
      'CREEK', 'CRIME', 'CROPS', 'CROSS', 'CROWD', 'CROWN', 'CRUDE', 'CRUSH', 'CURVE', 'CYCLE',
      'DAILY', 'DANCE', 'DATED', 'DEALT', 'DEATH', 'DEBUT', 'DECKS', 'DELAY', 'DEPTH', 'DERBY',
      'DESKS', 'DIARY', 'DICED', 'DIRTY', 'DISCO', 'DITTY', 'DOCKS', 'DODGE', 'DOING', 'DOORS',
      'DOUBT', 'DOZEN', 'DRAFT', 'DRAIN', 'DRAMA', 'DRANK', 'DREAM', 'DRESS', 'DRIED', 'DRILL',
      'DRINK', 'DRIVE', 'DROVE', 'DRUMS', 'DRUNK', 'DYING', 'EAGER', 'EARLY', 'EARTH', 'EIGHT',
      'ELDER', 'ELITE', 'EMPTY', 'ENEMY', 'ENJOY', 'ENTER', 'ENTRY', 'EQUAL', 'ERROR', 'EVENT',
      'EVERY', 'EXACT', 'EXIST', 'EXTRA', 'FACED', 'FACTS', 'FAITH', 'FALSE', 'FANCY', 'FARMS',
      'FATAL', 'FAULT', 'FAVOR', 'FEARS', 'FENCE', 'FIBER', 'FIELD', 'FIFTH', 'FIFTY', 'FIGHT',
      'FILED', 'FILLS', 'FILMS', 'FINAL', 'FINDS', 'FINES', 'FIRED', 'FIRES', 'FIRST', 'FIXED',
      'FLAGS', 'FLAME', 'FLASH', 'FLEET', 'FLESH', 'FLIES', 'FLOAT', 'FLOOD', 'FLOOR', 'FLOUR',
      'FLOWS', 'FLUID', 'FOCUS', 'FOLKS', 'FOODS', 'FORCE', 'FORMS', 'FORTH', 'FORTY', 'FORUM',
      'FOUND', 'FRAME', 'FRANK', 'FRAUD', 'FRESH', 'FRIED', 'FRONT', 'FROST', 'FRUIT', 'FULLY',
      'FUNNY', 'FUZZY', 'GAMES', 'GATES', 'GAUGE', 'GHOST', 'GIANT', 'GIFTS', 'GIRLS', 'GIVEN',
      'GLASS', 'GLOBE', 'GLOVE', 'GOALS', 'GOATS', 'GOING', 'GOODS', 'GRACE', 'GRADE', 'GRAIN',
      'GRAND', 'GRANT', 'GRAPE', 'GRAPH', 'GRASS', 'GRAVE', 'GREAT', 'GREEN', 'GREET', 'GRIEF',
      'GRILL', 'GRIND', 'GRIPS', 'GROSS', 'GROUP', 'GROWN', 'GUARD', 'GUESS', 'GUEST', 'GUIDE',
      'GUILD', 'HAPPY', 'HARSH', 'HASTE', 'HATED', 'HAVEN', 'HEADS', 'HEART', 'HEAVY', 'HELPS',
      'HENCE', 'HERBS', 'HILLS', 'HINTS', 'HIRED', 'HOLDS', 'HOLES', 'HOMES', 'HONEY', 'HOOKS',
      'HOPES', 'HORSE', 'HOTEL', 'HOURS', 'HOUSE', 'HUMAN', 'HUMOR', 'HURRY', 'HURTS', 'ICONS',
      'IDEAS', 'IMAGE', 'IMPLY', 'INDEX', 'INNER', 'INPUT', 'ISSUE', 'ITEMS', 'JEANS', 'JOBS',
      'JOINS', 'JOINT', 'JOKES', 'JUDGE', 'JUICE', 'JUMPS', 'KEEPS', 'KICKS', 'KILLS', 'KINDS',
      'KINGS', 'KNIFE', 'KNOCK', 'KNOWN', 'KNOWS', 'LABEL', 'LABOR', 'LACKS', 'LAKES', 'LANDS',
      'LARGE', 'LASER', 'LATER', 'LAUGH', 'LAYER', 'LEADS', 'LEARN', 'LEASE', 'LEAST', 'LEAVE',
      'LEGAL', 'LEVEL', 'Lewis', 'LIGHT', 'LIKED', 'LIKES', 'LIMIT', 'LINED', 'LINES', 'LINKS',
      'LISTS', 'LIVED', 'LIVER', 'LIVES', 'LOANS', 'LOCAL', 'LOCKS', 'LODGE', 'LOGIC', 'LOOKS',
      'LOOSE', 'LORDS', 'LOSES', 'LOVED', 'LOVER', 'LOVES', 'LOWER', 'LUCKY', 'LUNCH', 'LYING',
      'MAGIC', 'MAJOR', 'MAKER', 'MAKES', 'MALES', 'MARCH', 'MARKS', 'MARRY', 'MATCH', 'MATES',
      'MATHS', 'MATTE', 'MAYBE', 'MAYOR', 'MEALS', 'MEANS', 'MEANT', 'MEATS', 'MEDIA', 'MEETS',
      'MELON', 'MEMOS', 'MENUS', 'MERCY', 'METAL', 'METER', 'MICRO', 'MIGHT', 'MILES', 'MINDS',
      'MINES', 'MINOR', 'MINUS', 'MIXED', 'MIXES', 'MODAL', 'MODEL', 'MODES', 'MOIST', 'MONEY',
      'MONKS', 'MONTH', 'MORAL', 'MOTOR', 'MOUNT', 'MOUSE', 'MOUTH', 'MOVED', 'MOVES', 'MOVIE',
      'MOWED', 'MUSIC', 'NAMES', 'NASTY', 'NEEDS', 'NERVE', 'NEVER', 'NEWLY', 'NIGHT', 'NODES',
      'NOISE', 'NORTH', 'NOSED', 'NOTED', 'NOTES', 'NOVEL', 'NURSE', 'OCCUR', 'OCEAN', 'OFFER',
      'OFTEN', 'OLDER', 'OPENS', 'OPERA', 'ORDER', 'OTHER', 'OUGHT', 'OWNED', 'OWNER', 'OXIDE',
      'PAGES', 'PAID', 'PAINT', 'PAIRS', 'PANEL', 'PANIC', 'PAPER', 'PARKS', 'PARTS', 'PARTY',
      'PASTA', 'PASTE', 'PATCH', 'PATHS', 'PEACE', 'PEAKS', 'PENNY', 'PHASE', 'PHONE', 'PHOTO',
      'PIANO', 'PICKS', 'PIECE', 'PILLS', 'PILOT', 'PINCH', 'PIPES', 'PITCH', 'PIZZA', 'PLACE',
      'PLAIN', 'PLANE', 'PLANS', 'PLANT', 'PLATE', 'PLAYS', 'PLAZA', 'PLOT', 'POEMS', 'POETS',
      'POINT', 'POLES', 'POOLS', 'PORTS', 'POUND', 'POWER', 'PRESS', 'PRICE', 'PRIDE', 'PRIME',
      'PRINT', 'PRIOR', 'PRIZE', 'PROOF', 'PROPS', 'PROUD', 'PROVE', 'PULLS', 'PUMPS', 'PUNCH',
      'PUPIL', 'PURSE', 'QUEEN', 'QUEST', 'QUEUE', 'QUICK', 'QUIET', 'QUITE', 'QUOTE', 'RACES',
      'RADIO', 'RAILS', 'RAINS', 'RAISE', 'RANKS', 'RAPID', 'RATES', 'RATIO', 'REACH', 'READS',
      'READY', 'REALM', 'REBEL', 'REFER', 'RELAX', 'RELAY', 'REPAY', 'REPLY', 'RIDER', 'RIDES',
      'RIGHT', 'RINGS', 'RISES', 'RISKS', 'RIVAL', 'RIVER', 'ROADS', 'ROAST', 'ROBOT', 'ROCKS',
      'ROLES', 'ROLLS', 'ROMAN', 'ROOMS', 'ROOTS', 'ROSES', 'ROUGH', 'ROUND', 'ROUTE', 'ROYAL',
      'RULES', 'RURAL', 'SAFER', 'SAINT', 'SALAD', 'SALES', 'SAUCE', 'SAVED', 'SAVES', 'SCALE',
      'SCARY', 'SCENE', 'SCOPE', 'SCORE', 'SCOTS', 'SEALS', 'SEATS', 'SEEMS', 'SELLS', 'SENDS',
      'SENSE', 'SERVE', 'SETUP', 'SEVEN', 'SHADE', 'SHAKE', 'SHALL', 'SHAME', 'SHAPE', 'SHARE',
      'SHARK', 'SHARP', 'SHEEP', 'SHEET', 'SHELF', 'SHELL', 'SHIFT', 'SHINE', 'SHIPS', 'SHIRT',
      'SHOCK', 'SHOES', 'SHOOT', 'SHOPS', 'SHORT', 'SHOTS', 'SHOWN', 'SHOWS', 'SIDES', 'SIGHT',
      'SIGNS', 'SILLY', 'SINCE', 'SINGS', 'SITES', 'SIXTH', 'SIXTY', 'SIZES', 'SKILL', 'SKINS',
      'SKIPS', 'SKULL', 'SLEEP', 'SLIDE', 'SLOPE', 'SMALL', 'SMART', 'SMELL', 'SMILE', 'SMOKE',
      'SNAKE', 'SNACK', 'SNOW', 'SOCKS', 'SOLID', 'SOLVE', 'SONGS', 'SORRY', 'SORTS', 'SOULS',
      'SOUND', 'SOUTH', 'SPACE', 'SPARE', 'SPEAK', 'SPEED', 'SPELL', 'SPEND', 'SPENT', 'SPIN',
      'SPLIT', 'SPOKE', 'SPORT', 'SPOTS', 'SPRAY', 'STACK', 'STAFF', 'STAGE', 'STAIR', 'STAKE',
      'STAMP', 'STAND', 'STARS', 'START', 'STATE', 'STAYS', 'STEAL', 'STEAM', 'STEEL', 'STEEP',
      'STICK', 'STILL', 'STOCK', 'STONE', 'STOOD', 'STOPS', 'STORE', 'STORM', 'STORY', 'STRIP',
      'STUCK', 'STUDY', 'STUFF', 'STYLE', 'SUGAR', 'SUITE', 'SUPER', 'SWEAT', 'SWEEP', 'SWEET',
      'SWIFT', 'SWING', 'TABLE', 'TAKES', 'TALES', 'TALKS', 'TANKS', 'TAPES', 'TASKS', 'TASTE',
      'TAXES', 'TEACH', 'TEAMS', 'TEARS', 'TEENS', 'TEETH', 'TELLS', 'TENDS', 'TERMS', 'TESTS',
      'TEXTS', 'THANK', 'THEFT', 'THEIR', 'THEME', 'THERE', 'THESE', 'THICK', 'THIN', 'THING',
      'THINK', 'THIRD', 'THOSE', 'THREE', 'THREW', 'THROW', 'THUMB', 'TIGER', 'TIGHT', 'TILES',
      'TIMES', 'TIRED', 'TITLE', 'TODAY', 'TOKEN', 'TOOLS', 'TOPIC', 'TOTAL', 'TOUCH', 'TOUGH',
      'TOURS', 'TOWER', 'TOWNS', 'TOYS', 'TRACK', 'TRADE', 'TRAIL', 'TRAIN', 'TRAIT', 'TRASH',
      'TREAT', 'TREES', 'TREND', 'TRIAL', 'TRIBE', 'TRICK', 'TRIED', 'TRIES', 'TRIPS', 'TRUCK',
      'TRULY', 'TRUNK', 'TRUST', 'TRUTH', 'TUBES', 'TURNS', 'TWICE', 'TWINS', 'TWIST', 'TYPES',
      'ULTRA', 'UNCLE', 'UNDER', 'UNDUE', 'UNION', 'UNITS', 'UNITY', 'UNTIL', 'UPPER', 'UPSET',
      'URBAN', 'URGED', 'USAGE', 'USERS', 'USES', 'USUAL', 'VALID', 'VALUE', 'VENUE', 'VIDEO',
      'VIEWS', 'VIRUS', 'VISIT', 'VITAL', 'VOCAL', 'VOICE', 'VOTES', 'WAGES', 'WAIST', 'WALKS',
      'WALLS', 'WANTS', 'WASTE', 'WATCH', 'WATER', 'WAVES', 'WEALTH', 'WEARS', 'WEIRD', 'WELLS',
      'WELSH', 'WHALE', 'WHEAT', 'WHEEL', 'WHERE', 'WHICH', 'WHILE', 'WHITE', 'WHOLE', 'WHOSE',
      'WINDS', 'WINES', 'WINGS', 'WIPES', 'WIRED', 'WIRES', 'WOMAN', 'WOMEN', 'WOODS', 'WORDS',
      'WORKS', 'WORLD', 'WORRY', 'WORSE', 'WORST', 'WORTH', 'WOULD', 'WRITE', 'WRONG', 'WROTE',
      'YEARS', 'YOUNG', 'YOUTH', 'YOURS', 'ZONES'
    ]);
    return validWords.has(word);
  }
}

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
            justify-content: center;
            margin-bottom: 10px;
        }

        .voting-buttons {
            display: flex;
            gap: 8px;
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

        .share-btn {
            background: #9b59b6;
            color: white;
        }

        .share-btn:hover:not(:disabled) {
            background: #8e44ad;
        }

        .vote-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .status {
            text-align: center;
            padding: 12px;
            margin: 15px 0 10px 0;
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

        .status.typing {
            background: #f8f9fa;
            color: #495057;
            border: 1px solid #dee2e6;
        }

        .keyboard {
            margin-top: 10px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 10px;
        }

        .keyboard-row {
            display: flex;
            justify-content: center;
            gap: 6px;
            margin-bottom: 8px;
        }

        .keyboard-row:last-child {
            margin-bottom: 0;
        }

        .key {
            min-width: 40px;
            height: 50px;
            border: 1px solid #d3d6da;
            border-radius: 4px;
            background: #ffffff;
            font-size: 1rem;
            font-weight: bold;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.1s ease;
            user-select: none;
        }

        .key:hover {
            background: #f8f9fa;
            border-color: #adb5bd;
        }

        .key:active {
            background: #e9ecef;
            transform: scale(0.95);
        }

        .key.wide {
            min-width: 65px;
            font-size: 0.8rem;
        }

        .key.correct {
            background: #6aaa64;
            border-color: #6aaa64;
            color: white;
        }

        .key.present {
            background: #c9b458;
            border-color: #c9b458;
            color: white;
        }

        .key.absent {
            background: #787c7e;
            border-color: #787c7e;
            color: white;
        }

        .notification {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #28a745;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .notification.show {
            opacity: 1;
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
            
            .keyboard {
                padding: 10px;
                margin-top: 15px;
            }
            
            .key {
                min-width: 30px;
                height: 40px;
                font-size: 0.9rem;
            }
            
            .key.wide {
                min-width: 50px;
                font-size: 0.7rem;
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

        <div class="players-online" id="playersOnline">
            Checking for players...
        </div>

        <div class="controls">
            <div class="voting-buttons">
                <button class="vote-btn share-btn" id="shareBtn" title="Share game with partner">📤</button>
                <button class="vote-btn propose-btn" id="proposeBtn" title="Propose this word" disabled>?</button>
                <button class="vote-btn agree-btn" id="agreeBtn" title="Agree with proposal" disabled>✓</button>
                <button class="vote-btn disagree-btn" id="disagreeBtn" title="Disagree with proposal" disabled>✗</button>
            </div>
        </div>

        <div class="status" id="status">Connecting to game...</div>

        <div class="game-board" id="gameBoard">
            <!-- Grid will be generated by JavaScript -->
        </div>

        <div class="keyboard" id="keyboard">
            <!-- Virtual keyboard will be generated by JavaScript -->
        </div>
    </div>

    <div class="notification" id="notification">URL copied to clipboard!</div>

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
                this.currentWord = ''; // Track current word being typed
                
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
                return roomCode;
            }

            generatePlayerId() {
                return 'player_' + Math.random().toString(36).substr(2, 9);
            }

            connect() {
                this.updateConnectionStatus('connecting', '🔄 Connecting to game server...');
                
                const wsUrl = \`\${location.protocol === 'https:' ? 'wss:' : 'ws:'}\${location.host}/websocket?room=\${this.roomCode}&playerId=\${this.playerId}&playerName=\${encodeURIComponent(this.playerName)}\`;
                
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    this.updateConnectionStatus('connected', '✅ Connected - real-time sync active!');
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
                    this.updateConnectionStatus('error', '❌ Connection lost - reconnecting...');
                    this.disableControls();
                    
                    if (this.heartbeatInterval) {
                        clearInterval(this.heartbeatInterval);
                    }
                    
                    // Attempt to reconnect
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        setTimeout(() => this.connect(), Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000));
                    } else {
                        this.updateConnectionStatus('error', '❌ Connection failed - please refresh');
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
                    playersEl.textContent = '👤 1 player online (waiting for partner)';
                } else {
                    playersEl.textContent = \`👥 \${onlinePlayers.length} players online - Ready to collaborate!\`;
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
                            // Update letter states for keyboard coloring
                            if (!this.letterStates[letter] || 
                                (this.letterStates[letter] !== 'correct' && state === 'correct') ||
                                (this.letterStates[letter] === 'absent' && state === 'present')) {
                                this.letterStates[letter] = state;
                            }
                        }
                    }
                }

                // Update keyboard colors based on letter states
                this.updateKeyboardColors();

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

                    // Proposer cannot vote, non-proposer can vote
                    if (isMyProposal) {
                        this.updateButtons(false, false, false); // Proposer: no voting
                    } else {
                        this.updateButtons(false, !myVote, !myVote); // Non-proposer: can vote if haven't voted
                    }
                } else {
                    this.updateWordDisplay(); // Show current typing or default message
                    this.updateButtons(true, false, false);
                }
            }

            updateGameStatus() {
                if (this.gameState?.gameState === 'won') {
                    this.updateStatus(\`🎉 Congratulations! You found the word: "\${this.gameState.targetWord}"!\`, 'success');
                    this.updateButtons(false, false, false);
                } else if (this.gameState?.gameState === 'lost') {
                    this.updateStatus(\`😔 Game over! The word was: "\${this.gameState.targetWord}"\`, 'error');
                    this.updateButtons(false, false, false);
                }
            }

            enableControls() {
                document.getElementById('proposeBtn').disabled = false;
            }

            disableControls() {
                document.getElementById('proposeBtn').disabled = true;
                document.getElementById('agreeBtn').disabled = true;
                document.getElementById('disagreeBtn').disabled = true;
            }

            initializeGame() {
                this.createGameBoard();
                this.createKeyboard();
                this.letterStates = {}; // Track letter states for keyboard coloring
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

            createKeyboard() {
                const keyboard = document.getElementById('keyboard');
                keyboard.innerHTML = '';
                
                const rows = [
                    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
                    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
                    ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
                ];
                
                rows.forEach(row => {
                    const rowEl = document.createElement('div');
                    rowEl.className = 'keyboard-row';
                    
                    row.forEach(key => {
                        const keyEl = document.createElement('div');
                        keyEl.className = 'key';
                        keyEl.textContent = key;
                        keyEl.dataset.key = key;
                        
                        if (key === 'ENTER' || key === '⌫') {
                            keyEl.classList.add('wide');
                        }
                        
                        keyEl.addEventListener('click', () => this.handleKeyClick(key));
                        rowEl.appendChild(keyEl);
                    });
                    
                    keyboard.appendChild(rowEl);
                });
            }

            handleKeyClick(key) {
                if (key === 'ENTER') {
                    this.proposeWord();
                } else if (key === '⌫') {
                    this.currentWord = this.currentWord.slice(0, -1);
                } else if (this.currentWord.length < 5) {
                    this.currentWord += key;
                }
                this.updateWordDisplay();
            }

            updateWordDisplay() {
                // Show current word being typed in the status
                if (this.currentWord.length > 0) {
                    this.updateStatus(\`Typing: \${this.currentWord}\`, 'typing');
                } else if (!this.gameState?.proposal) {
                    this.updateStatus('Type a 5-letter word using the keyboard below!');
                }
            }

            updateKeyboardColors() {
                Object.keys(this.letterStates).forEach(letter => {
                    const keyEl = document.querySelector(\`[data-key="\${letter}"]\`);
                    if (keyEl) {
                        keyEl.className = 'key';
                        if (this.letterStates[letter] === 'correct') {
                            keyEl.classList.add('correct');
                        } else if (this.letterStates[letter] === 'present') {
                            keyEl.classList.add('present');
                        } else if (this.letterStates[letter] === 'absent') {
                            keyEl.classList.add('absent');
                        }
                    }
                });
            }

            setupEventListeners() {
                const shareBtn = document.getElementById('shareBtn');
                const proposeBtn = document.getElementById('proposeBtn');
                const agreeBtn = document.getElementById('agreeBtn');
                const disagreeBtn = document.getElementById('disagreeBtn');

                shareBtn.addEventListener('click', () => this.shareGame());
                proposeBtn.addEventListener('click', () => this.proposeWord());
                agreeBtn.addEventListener('click', () => this.vote(true));
                disagreeBtn.addEventListener('click', () => this.vote(false));
            }

            proposeWord() {
                const word = this.currentWord.trim();

                if (word.length !== 5) {
                    this.updateStatus('Word must be exactly 5 letters!', 'error');
                    return;
                }

                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'propose',
                        word: word
                    }));
                    this.currentWord = '';
                    this.updateWordDisplay();
                } else {
                    this.updateStatus('Not connected to server', 'error');
                }
            }

            async shareGame() {
                try {
                    await navigator.clipboard.writeText(window.location.href);
                    this.showNotification('URL copied to clipboard!');
                } catch (err) {
                    console.error('Failed to copy URL:', err);
                    this.showNotification('Failed to copy URL');
                }
            }

            showNotification(message) {
                const notification = document.getElementById('notification');
                notification.textContent = message;
                notification.classList.add('show');
                
                setTimeout(() => {
                    notification.classList.remove('show');
                }, 3000);
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
    </script>
</body>
</html>`;
}