/**
 * =====================================================================
 * PROJECT: HOÀNG VIP WIN - ULTIMATE LOTTERY API & PREDICTION SERVER
 * VERSION: 5.0 ENTERPRISE EDITION
 * AUTHOR: TRẦN NHẬT HOÀNG (ÔNG VUA PHÂN TÍCH)
 * DESCRIPTION: High-performance Node.js server with multi-layer deep
 *              pattern analysis, Markov chains, Bayesian inference,
 *              genetic algorithms & neural-inspired scoring.
 * =====================================================================
 */

'use strict';

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 1. GLOBAL CONFIGURATIONS ====================

const CONFIG = {
    SERVER_NAME: 'HOÀNG VIP WIN ENTERPRISE',
    VERSION: '5.0.0',
    API_BASE: 'https://k2d9u.k123b.club/api/front/open/lottery/history/list/game',
    CACHE_TTL_MS: 30000,
    MAX_CACHE_SIZE: 500,
    REQUEST_TIMEOUT_MS: 12000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 800,
    RATE_LIMIT: {
        windowMs: 60000,
        maxRequests: 120
    },
    GAME_DICTIONARY: {
        'st45g': { name: 'XSMB 45 Giây', type: 'fast', baseInterval: 45 },
        'st1p': { name: 'XSMB 1 Phút', type: 'medium', baseInterval: 60 },
        'bali': { name: 'Bạc Liêu', type: 'traditional', baseInterval: 86400 },
        'platvnk330s': { name: 'Tài Xỉu 30 Giây', type: 'dice', baseInterval: 30 },
        'st3p': { name: 'XSMB 3 Phút', type: 'medium', baseInterval: 180 },
        'st5p': { name: 'XSMB 5 Phút', type: 'medium', baseInterval: 300 },
        'mn': { name: 'Miền Nam', type: 'traditional', baseInterval: 86400 },
        'mt': { name: 'Miền Trung', type: 'traditional', baseInterval: 86400 }
    }
};

// ==================== 2. ADVANCED LOGGER SYSTEM ====================

class Logger {
    constructor() {
        this.levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
        this.currentLevel = this.levels.INFO;
        this.history = [];
        this.maxHistory = 1000;
    }

    _log(level, ...args) {
        const timestamp = new Date().toISOString();
        const entry = {
            timestamp,
            level,
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        };
        this.history.push(entry);
        if (this.history.length > this.maxHistory) this.history.shift();

        if (this.levels[level] >= this.currentLevel) {
            const prefix = `[${timestamp}] [${level}]`;
            if (level === 'ERROR') console.error(prefix, ...args);
            else if (level === 'WARN') console.warn(prefix, ...args);
            else console.log(prefix, ...args);
        }
    }

    debug(...args) { this._log('DEBUG', ...args); }
    info(...args) { this._log('INFO', ...args); }
    warn(...args) { this._log('WARN', ...args); }
    error(...args) { this._log('ERROR', ...args); }
}

const logger = new Logger();

// ==================== 3. EVENT BUS (PUB/SUB) ====================

class EventBus extends EventEmitter {}
const eventBus = new EventBus();

eventBus.on('api:request', (data) => {
    logger.debug(`[EVENT] API Request: ${data.method} ${data.path}`);
});

eventBus.on('prediction:complete', (data) => {
    logger.info(`[EVENT] Prediction complete for ${data.gameCode} in ${data.duration}ms`);
});

eventBus.on('cache:hit', (key) => {
    logger.debug(`[EVENT] Cache HIT: ${key}`);
});

eventBus.on('cache:miss', (key) => {
    logger.debug(`[EVENT] Cache MISS: ${key}`);
});

// ==================== 4. ADVANCED CACHE SYSTEM (LRU + TTL) ====================

class LRUCache {
    constructor(maxSize = 500, ttl = 30000) {
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.cache = new Map();
        this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
    }

    _isExpired(entry) {
        return Date.now() - entry.timestamp > this.ttl;
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses++;
            eventBus.emit('cache:miss', key);
            return null;
        }
        if (this._isExpired(entry)) {
            this.cache.delete(key);
            this.stats.expirations++;
            this.stats.misses++;
            eventBus.emit('cache:miss', key);
            return null;
        }
        // Refresh LRU position
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.stats.hits++;
        eventBus.emit('cache:hit', key);
        return entry.value;
    }

    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
            this.stats.evictions++;
        }
        this.cache.set(key, { value, timestamp: Date.now() });
    }

    invalidate(pattern) {
        let count = 0;
        for (const key of this.cache.keys()) {
            if (key.includes(pattern)) {
                this.cache.delete(key);
                count++;
            }
        }
        return count;
    }

    flush() {
        this.cache.clear();
    }

    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            ...this.stats,
            hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
        };
    }
}

const apiCache = new LRUCache(CONFIG.MAX_CACHE_SIZE, CONFIG.CACHE_TTL_MS);

// ==================== 5. RATE LIMITER ====================

class RateLimiter {
    constructor(windowMs, maxRequests) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.clients = new Map();
    }

    isAllowed(ip) {
        const now = Date.now();
        const client = this.clients.get(ip) || { count: 0, resetAt: now + this.windowMs };

        if (now > client.resetAt) {
            client.count = 0;
            client.resetAt = now + this.windowMs;
        }

        client.count++;
        this.clients.set(ip, client);
        return client.count <= this.maxRequests;
    }

    cleanup() {
        const now = Date.now();
        for (const [ip, client] of this.clients.entries()) {
            if (now > client.resetAt) this.clients.delete(ip);
        }
    }
}

const rateLimiter = new RateLimiter(CONFIG.RATE_LIMIT.windowMs, CONFIG.RATE_LIMIT.maxRequests);
setInterval(() => rateLimiter.cleanup(), 60000);

// ==================== 6. MIDDLEWARES ====================

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// JSON body parser
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, res, next) => {
    req._startTime = Date.now();
    req._id = crypto.randomBytes(8).toString('hex');
    eventBus.emit('api:request', { method: req.method, path: req.path });
    res.on('finish', () => {
        const duration = Date.now() - req._startTime;
        logger.info(`[REQ-${req._id}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// Rate limiter middleware
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimiter.isAllowed(ip)) {
        return res.status(429).json({
            status: 'error',
            code: 429,
            message: 'Quá nhiều yêu cầu! Vui lòng chậm lại.',
            retryAfter: Math.ceil(CONFIG.RATE_LIMIT.windowMs / 1000)
        });
    }
    next();
});

// ==================== 7. UTILITY HELPERS ====================

const Utils = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),

    safeParseInt: (val, fallback = 0) => {
        const n = parseInt(val, 10);
        return isNaN(n) ? fallback : n;
    },

    extractDigits: (str) => String(str || '').replace(/[^0-9]/g, '').split(''),

    sumDigits: (arr) => arr.reduce((s, d) => s + Utils.safeParseInt(d), 0),

    average: (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,

    standardDeviation: (arr) => {
        if (!arr.length) return 0;
        const avg = Utils.average(arr);
        return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / arr.length);
    },

    mode: (arr) => {
        const freq = {};
        let best = null, bestCount = 0;
        arr.forEach(v => {
            freq[v] = (freq[v] || 0) + 1;
            if (freq[v] > bestCount) { best = v; bestCount = freq[v]; }
        });
        return best;
    },

    median: (arr) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },

    percentile: (arr, p) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    },

    hash: (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').substring(0, 16),

    padNumber: (n, len = 2) => String(n).padStart(len, '0'),

    generateCombinations: (arr, k) => {
        const result = [];
        const helper = (start, current) => {
            if (current.length === k) return result.push([...current]);
            for (let i = start; i < arr.length; i++) {
                current.push(arr[i]);
                helper(i + 1, current);
                current.pop();
            }
        };
        helper(0, []);
        return result;
    }
};

// ==================== 8. FETCH LAYER WITH RETRY ====================

async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            logger.debug(`Fetching ${url} (attempt ${attempt}/${retries})`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
            return await response.json();
        } catch (err) {
            lastError = err;
            logger.warn(`Fetch attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) await Utils.sleep(CONFIG.RETRY_DELAY_MS * attempt);
        }
    }
    throw lastError;
}

async function fetchLotteryData(gameCode, limitNum = 15) {
    const cacheKey = `lottery:${gameCode}:${limitNum}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;

    const url = `${CONFIG.API_BASE}?limitNum=${limitNum}&gameCode=${gameCode}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://k123b.club/',
        'Origin': 'https://k123b.club'
    };

    const json = await fetchWithRetry(url, { headers });
    apiCache.set(cacheKey, json);
    return json;
}

// ==================== 9. DATA NORMALIZATION ====================

class DataNormalizer {
    static normalizeSessions(rawJson) {
        const rows = rawJson.rows || rawJson.data || [];
        if (!Array.isArray(rows) || rows.length === 0) return [];

        const issueList = rows[0].issueList || [];
        return issueList.map((issue, idx) => {
            const details = Array.isArray(issue.detail) ? issue.detail : [];
            const extractedDigits = [];
            details.forEach(d => {
                const clean = String(d).replace(/[^0-9]/g, '');
                extractedDigits.push(...clean.split(''));
            });

            const openNumClean = String(issue.openNum || '').replace(/[^0-9]/g, '');
            if (extractedDigits.length === 0 && openNumClean) {
                extractedDigits.push(...openNumClean.split(''));
            }

            const special = details[0] ? String(details[0]).replace(/[^0-9]/g, '') : openNumClean;

            return {
                index: idx,
                turnNum: issue.turnNum || `Kỳ_${idx + 1}`,
                openTime: issue.openTime || null,
                openNum: issue.openNum || null,
                detail: details,
                digits: extractedDigits,
                specialNumber: special,
                specialLast2: special.slice(-2),
                specialLast3: special.slice(-3),
                digitSum: Utils.sumDigits(extractedDigits),
                digitCount: extractedDigits.length,
                head: extractedDigits[0] || null,
                tail: extractedDigits[extractedDigits.length - 1] || null
            };
        });
    }

    static extractAllDigits(sessions) {
        return sessions.flatMap(s => s.digits);
    }

    static extractSpecialNumbers(sessions) {
        return sessions.map(s => s.specialNumber).filter(Boolean);
    }
}

// ==================== 10. STATISTICAL ANALYSIS ENGINE ====================

class StatisticsEngine {
    static buildFrequencyMap(digits) {
        const map = {};
        digits.forEach(d => { map[d] = (map[d] || 0) + 1; });
        return map;
    }

    static rankDigits(freqMap) {
        return Object.entries(freqMap)
            .sort((a, b) => b[1] - a[1])
            .map(([d, c]) => ({ digit: d, count: c }));
    }

    static computeGaps(digits, target) {
        const gaps = [];
        let counter = 0;
        digits.forEach(d => {
            if (d === target) { gaps.push(counter); counter = 0; }
            else counter++;
        });
        return gaps;
    }

    static computeTrend(digits) {
        if (digits.length < 4) return 'neutral';
        const nums = digits.map(d => Utils.safeParseInt(d));
        const half = Math.floor(nums.length / 2);
        const firstHalf = Utils.average(nums.slice(0, half));
        const secondHalf = Utils.average(nums.slice(half));
        const diff = secondHalf - firstHalf;
        if (diff > 0.5) return 'rising';
        if (diff < -0.5) return 'falling';
        return 'stable';
    }

    static computeHeatScore(digits, recentWindow = 10) {
        const recent = digits.slice(-recentWindow);
        const total = digits.length || 1;
        const freqMap = this.buildFrequencyMap(digits);
        const recentFreq = this.buildFrequencyMap(recent);
        const heat = {};
        for (let d = 0; d <= 9; d++) {
            const key = String(d);
            const overall = (freqMap[key] || 0) / total;
            const recency = (recentFreq[key] || 0) / (recent.length || 1);
            heat[key] = +(overall * 0.35 + recency * 0.65).toFixed(4);
        }
        return heat;
    }

    static computeTailHeads(sessions) {
        const heads = {}, tails = {};
        sessions.forEach(s => {
            if (s.head !== null) heads[s.head] = (heads[s.head] || 0) + 1;
            if (s.tail !== null) tails[s.tail] = (tails[s.tail] || 0) + 1;
        });
        return { heads, tails };
    }

    static computeSumDistribution(sessions) {
        const sums = {};
        sessions.forEach(s => {
            if (s.digitSum > 0) sums[s.digitSum] = (sums[s.digitSum] || 0) + 1;
        });
        return sums;
    }
}

// ==================== 11. MARKOV CHAIN ANALYZER ====================

class MarkovAnalyzer {
    static buildTransitionMatrix(digits) {
        const matrix = {};
        for (let i = 0; i < digits.length - 1; i++) {
            const from = digits[i];
            const to = digits[i + 1];
            if (!matrix[from]) matrix[from] = {};
            matrix[from][to] = (matrix[from][to] || 0) + 1;
        }
        return matrix;
    }

    static predictNext(digits) {
        if (digits.length < 2) return [];
        const matrix = this.buildTransitionMatrix(digits);
        const lastDigit = digits[digits.length - 1];
        const transitions = matrix[lastDigit] || {};
        return Object.entries(transitions)
            .sort((a, b) => b[1] - a[1])
            .map(([digit, count]) => ({ digit, probability: count / Object.values(transitions).reduce((s, v) => s + v, 0) }));
    }

    static buildNGramMatrix(digits, n = 3) {
        const matrix = {};
        for (let i = 0; i <= digits.length - n; i++) {
            const context = digits.slice(i, i + n - 1).join('');
            const next = digits[i + n - 1];
            if (!matrix[context]) matrix[context] = {};
            matrix[context][next] = (matrix[context][next] || 0) + 1;
        }
        return matrix;
    }

    static predictNGram(digits, n = 3) {
        if (digits.length < n) return [];
        const matrix = this.buildNGramMatrix(digits, n);
        const context = digits.slice(-(n - 1)).join('');
        const candidates = matrix[context] || {};
        const total = Object.values(candidates).reduce((s, v) => s + v, 0) || 1;
        return Object.entries(candidates)
            .sort((a, b) => b[1] - a[1])
            .map(([digit, count]) => ({ digit, probability: +(count / total).toFixed(4) }));
    }
}

// ==================== 12. BAYESIAN SCORING ENGINE ====================

class BayesianScorer {
    static scoreDigits(digits, priorWeight = 0.3) {
        const total = digits.length || 1;
        const freq = StatisticsEngine.buildFrequencyMap(digits);
        const score = {};
        for (let d = 0; d <= 9; d++) {
            const key = String(d);
            const observed = freq[key] || 0;
            const posterior = (observed + 1) / (total + 10); // Laplace smoothing
            score[key] = +(priorWeight * 0.1 + (1 - priorWeight) * posterior).toFixed(4);
        }
        return score;
    }

    static combineScores(...scoreObjects) {
        const combined = {};
        scoreObjects.forEach(scores => {
            Object.entries(scores).forEach(([digit, s]) => {
                combined[digit] = (combined[digit] || 0) + s;
            });
        });
        // Normalize
        const sum = Object.values(combined).reduce((a, b) => a + b, 0) || 1;
        Object.keys(combined).forEach(k => combined[k] = +(combined[k] / sum).toFixed(4));
        return combined;
    }
}

// ==================== 13. GENETIC ALGORITHM OPTIMIZER ====================

class GeneticOptimizer {
    static generatePopulation(size = 50, geneLength = 4) {
        return Array.from({ length: size }, () =>
            Array.from({ length: geneLength }, () => Math.floor(Math.random() * 10))
        );
    }

    static fitness(individual, heatScore) {
        return individual.reduce((sum, gene) => sum + (heatScore[String(gene)] || 0), 0);
    }

    static crossover(parent1, parent2) {
        const point = Math.floor(Math.random() * parent1.length);
        return [...parent1.slice(0, point), ...parent2.slice(point)];
    }

    static mutate(individual, rate = 0.15) {
        return individual.map(g => Math.random() < rate ? Math.floor(Math.random() * 10) : g);
    }

    static evolve(heatScore, generations = 20, popSize = 40) {
        let population = this.generatePopulation(popSize, 4);
        for (let gen = 0; gen < generations; gen++) {
            const scored = population
                .map(ind => ({ ind, fit: this.fitness(ind, heatScore) }))
                .sort((a, b) => b.fit - a.fit);
            const survivors = scored.slice(0, Math.floor(popSize / 2)).map(s => s.ind);
            const nextGen = [...survivors];
            while (nextGen.length < popSize) {
                const p1 = survivors[Math.floor(Math.random() * survivors.length)];
                const p2 = survivors[Math.floor(Math.random() * survivors.length)];
                nextGen.push(this.mutate(this.crossover(p1, p2)));
            }
            population = nextGen;
        }
        return population
            .map(ind => ({ ind, fit: this.fitness(ind, heatScore) }))
            .sort((a, b) => b.fit - a.fit)
            .slice(0, 5)
            .map(s => ({ combination: s.ind.map(String).join(''), fitness: +s.fit.toFixed(4) }));
    }
}

// ==================== 14. MULTI-LAYER PREDICTION ENGINE ====================

class PredictionEngine {
    constructor(sessions, gameName) {
        this.sessions = sessions;
        this.gameName = gameName;
        this.allDigits = DataNormalizer.extractAllDigits(sessions);
        this.specialNumbers = DataNormalizer.extractSpecialNumbers(sessions);
    }

    _ensureDigitsPool() {
        if (this.allDigits.length === 0) {
            this.allDigits = ['6','8','2','4','7','9','5','1','3','0'];
        }
    }

    buildFrequencyLayer() {
        this._ensureDigitsPool();
        const freq = StatisticsEngine.buildFrequencyMap(this.allDigits);
        const ranked = StatisticsEngine.rankDigits(freq);
        return { frequencyMap: freq, ranked };
    }

    buildHeatLayer() {
        this._ensureDigitsPool();
        return StatisticsEngine.computeHeatScore(this.allDigits);
    }

    buildMarkovLayer() {
        this._ensureDigitsPool();
        const bigram = MarkovAnalyzer.predictNext(this.allDigits);
        const trigram = MarkovAnalyzer.predictNGram(this.allDigits, 3);
        return { bigram, trigram };
    }

    buildBayesianLayer() {
        this._ensureDigitsPool();
        const freqScore = BayesianScorer.scoreDigits(this.allDigits);
        const heat = StatisticsEngine.computeHeatScore(this.allDigits);
        const combined = BayesianScorer.combineScores(freqScore, heat);
        return { freqScore, combined };
    }

    buildTrendLayer() {
        this._ensureDigitsPool();
        return {
            trend: StatisticsEngine.computeTrend(this.allDigits),
            stdDev: +StatisticsEngine.standardDeviation(this.allDigits.map(d => +d)).toFixed(3),
            median: StatisticsEngine.median(this.allDigits.map(d => +d)),
            p25: StatisticsEngine.percentile(this.allDigits.map(d => +d), 25),
            p75: StatisticsEngine.percentile(this.allDigits.map(d => +d), 75)
        };
    }

    buildGeneticLayer(heatScore) {
        return GeneticOptimizer.evolve(heatScore, 15, 30);
    }

    buildCombinatorialNumbers(freqRanked) {
        const top = freqRanked.slice(0, 6).map(x => x.digit);
        const pad = (a) => (a.length < 2 ? ['0', ...a] : a);
        const digits = pad(top);
        const pairs = [];
        for (let i = 0; i < digits.length; i++) {
            for (let j = i + 1; j < digits.length; j++) {
                pairs.push(digits[i] + digits[j]);
            }
        }
        return {
            bachThuLo: freqRanked[0] ? freqRanked[0].digit + (freqRanked[1]?.digit || '0') : '68',
            songThuLo: {
                con1: freqRanked[1] ? freqRanked[1].digit + (freqRanked[0]?.digit || '6') : '86',
                con2: freqRanked[2] ? freqRanked[2].digit + (freqRanked[3]?.digit || '2') : '24'
            },
            loXien2: {
                con1: freqRanked[0] ? freqRanked[0].digit + (freqRanked[2]?.digit || '2') : '62',
                con2: freqRanked[1] ? freqRanked[1].digit + (freqRanked[3]?.digit || '4') : '84'
            },
            loXien3: [
                `${freqRanked[0]?.digit || '6'}${freqRanked[1]?.digit || '8'}${freqRanked[2]?.digit || '2'}`,
                `${freqRanked[1]?.digit || '8'}${freqRanked[2]?.digit || '2'}${freqRanked[3]?.digit || '4'}`
            ],
            danDe10So: digits.slice(0, 10).map(d => d).join(', '),
            danDe20So: pairs.slice(0, 20),
            threeCang: this.specialNumbers.length > 0
                ? this.specialNumbers.slice(-5).map(n => n.slice(-3) || '000')
                : ['682', '824', '246']
        };
    }

    computeConfidence(freqRanked) {
        if (!freqRanked.length) return 0;
        const topCounts = freqRanked.slice(0, 4).map(x => x.count);
        const total = freqRanked.reduce((s, x) => s + x.count, 0);
        const concentration = topCounts.reduce((a, b) => a + b, 0) / total;
        const stdDev = StatisticsEngine.standardDeviation(freqRanked.map(x => x.count));
        const stability = 1 / (1 + stdDev);
        return +((concentration * 0.6 + stability * 0.4) * 100).toFixed(2);
    }

    run() {
        const t0 = Date.now();
        const freqLayer = this.buildFrequencyLayer();
        const heatLayer = this.buildHeatLayer();
        const markovLayer = this.buildMarkovLayer();
        const bayesLayer = this.buildBayesianLayer();
        const trendLayer = this.buildTrendLayer();
        const geneticLayer = this.buildGeneticLayer(heatLayer);
        const numbers = this.buildCombinatorialNumbers(freqLayer.ranked);
        const confidence = this.computeConfidence(freqLayer.ranked);

        // Latest session reference
        const latest = this.sessions[0] || {};
        const tailHeads = StatisticsEngine.computeTailHeads(this.sessions);
        const sumDist = StatisticsEngine.computeSumDistribution(this.sessions);

        const duration = Date.now() - t0;
        eventBus.emit('prediction:complete', { gameCode: this.gameName, duration });

        return {
            header: {
                tieuDe: 'ÔNG VUA PHÂN TÍCH - HOÀNG VIP WIN ENTERPRISE',
                troChoi: this.gameName,
                phienThamChieu: latest.turnNum || 'N/A',
                thoiGianMoThuong: latest.openTime || 'N/A'
            },
            ketQuaSoiCau: numbers,
            thongKeNangCao: {
                tanSuat: freqLayer.frequencyMap,
                xepHang: freqLayer.ranked.slice(0, 10),
                heatScore: heatLayer,
                dauDuoi: tailHeads,
                phanBoTong: sumDist,
                xuHuong: trendLayer,
                markovBigram: markovLayer.bigram.slice(0, 5),
                markovTrigram: markovLayer.trigram.slice(0, 5),
                bayesScore: bayesLayer.combined
            },
            toiUuHoaGenetic: geneticLayer,
            doTinCay: `${confidence}%`,
            meta: {
                thuatToan: [
                    'Deep Frequency Weighting',
                    'Heat Score Decay',
                    'Markov Chain (Bi/Tri-gram)',
                    'Bayesian Inference',
                    'Genetic Optimizer',
                    'Trend Analysis'
                ],
                tongMauPhanTich: this.allDigits.length,
                soKyQuay: this.sessions.length,
                thoiGianXuLyMs: duration,
                timestamp: new Date().toISOString()
            }
        };
    }
}

// ==================== 15. EXPORT HELPERS ====================

function formatHistoryOutput(rawJson, gameCode) {
    const rows = rawJson.rows || rawJson.data || [];
    return rows.map(item => ({
        tenGame: item.name || CONFIG.GAME_DICTIONARY[gameCode]?.name || 'N/A',
        maCode: item.code || gameCode,
        danhSachPhien: (item.issueList || []).map(issue => ({
            phien: issue.turnNum || 'N/A',
            thoiGianMoThuong: issue.openTime || 'N/A',
            ketQuaNhanh: issue.openNum || 'N/A',
            chiTietGiaiThuong: issue.detail || []
        }))
    }));
}

async function getSessionsForGame(gameCode, limitNum = 15) {
    const rawJson = await fetchLotteryData(gameCode, limitNum);
    return DataNormalizer.normalizeSessions(rawJson);
}

// ==================== 16. ROUTES ====================

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: CONFIG.SERVER_NAME,
        version: CONFIG.VERSION,
        author: 'Trần Nhật Hoàng (Hoàng Vip Win)',
        message: '🔥 HOÀNG VIP WIN ENTERPRISE API SERVER IS ACTIVE 🔥',
        systemTime: new Date().toISOString(),
        cacheStats: apiCache.getStats(),
        endpoints: {
            '/': 'Tài liệu hệ thống',
            '/api/health': 'Health check chi tiết',
            '/api/history/:gameCode?limit=N': 'Lịch sử kết quả',
            '/api/predict/:gameCode': 'Dự đoán VIP đa tầng',
            '/api/stats/:gameCode': 'Thống kê tần suất',
            '/api/advanced/:gameCode': 'Phân tích nâng cao đầy đủ',
            '/api/compare?games=a,b,c': 'So sánh nhiều game',
            '/api/rank/:gameCode': 'Xếp hạng digit top',
            '/api/markov/:gameCode': 'Chuỗi Markov',
            '/api/heat/:gameCode': 'Heat score',
            '/api/genetic/:gameCode': 'Genetic optimizer',
            '/api/cache/stats': 'Cache thống kê',
            '/api/cache/flush': 'Xóa cache (POST)',
            '/api/logs?limit=N': 'Xem logs gần đây'
        },
        supportedGames: CONFIG.GAME_DICTIONARY
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cache: apiCache.getStats(),
        timestamp: new Date().toISOString()
    });
});

// History endpoint
app.get('/api/history/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    const limitNum = Math.min(Utils.safeParseInt(req.query.limit, 10), 100);
    try {
        const rawJson = await fetchLotteryData(gameCode, limitNum);
        const formatted = formatHistoryOutput(rawJson, gameCode);
        res.json({
            status: 'success',
            gameCode,
            totalRecords: formatted.length,
            data: formatted
        });
    } catch (err) {
        logger.error(`History error for ${gameCode}:`, err.message);
        res.status(500).json({ status: 'error', message: 'Không thể lấy lịch sử!', details: err.message });
    }
});

// Prediction endpoint
app.get('/api/predict/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    const gameName = CONFIG.GAME_DICTIONARY[gameCode]?.name || gameCode;
    try {
        const sessions = await getSessionsForGame(gameCode, 20);
        if (!sessions.length) {
            return res.status(400).json({ status: 'warning', message: 'Không đủ dữ liệu!' });
        }
        const engine = new PredictionEngine(sessions, gameName);
        const result = engine.run();
        res.json({ status: 'success', gameCode, duDoanVip: result });
    } catch (err) {
        logger.error(`Predict error for ${gameCode}:`, err.message);
        res.status(500).json({ status: 'error', message: 'Lỗi thuật toán dự đoán!', details: err.message });
    }
});

// Stats endpoint
app.get('/api/stats/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 25);
        const digits = DataNormalizer.extractAllDigits(sessions);
        const freq = StatisticsEngine.buildFrequencyMap(digits);
        const ranked = StatisticsEngine.rankDigits(freq);
        res.json({
            status: 'success',
            gameCode,
            tongChuSo: digits.length,
            soKyQuay: sessions.length,
            bangTanSuat: freq,
            xepHang: ranked,
            thongKe: {
                mean: +Utils.average(digits.map(Number)).toFixed(3),
                stdDev: +Utils.standardDeviation(digits.map(Number)).toFixed(3),
                median: StatisticsEngine.median(digits.map(Number)),
                mode: StatisticsEngine.mode(digits)
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Advanced full analysis
app.get('/api/advanced/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    const gameName = CONFIG.GAME_DICTIONARY[gameCode]?.name || gameCode;
    try {
        const sessions = await getSessionsForGame(gameCode, 30);
        const engine = new PredictionEngine(sessions, gameName);
        const full = engine.run();

        // Add extra layers
        const digits = DataNormalizer.extractAllDigits(sessions);
        const nGram4 = MarkovAnalyzer.predictNGram(digits, 4);
        const nGram5 = MarkovAnalyzer.predictNGram(digits, 5);

        res.json({
            status: 'success',
            gameCode,
            analysis: {
                ...full,
                thongKeMarkovMoRong: {
                    nGram4: nGram4.slice(0, 5),
                    nGram5: nGram5.slice(0, 5)
                }
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Compare multiple games
app.get('/api/compare', async (req, res) => {
    const games = String(req.query.games || 'st45g,st1p,bali').split(',').slice(0, 5);
    try {
        const results = await Promise.all(games.map(async g => {
            try {
                const sessions = await getSessionsForGame(g, 15);
                const engine = new PredictionEngine(sessions, CONFIG.GAME_DICTIONARY[g]?.name || g);
                return { game: g, prediction: engine.run() };
            } catch (e) {
                return { game: g, error: e.message };
            }
        }));
        res.json({ status: 'success', count: results.length, results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Rank digits
app.get('/api/rank/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 20);
        const digits = DataNormalizer.extractAllDigits(sessions);
        const freq = StatisticsEngine.buildFrequencyMap(digits);
        const ranked = StatisticsEngine.rankDigits(freq);
        res.json({ status: 'success', gameCode, xepHang: ranked });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Markov chain
app.get('/api/markov/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 20);
        const digits = DataNormalizer.extractAllDigits(sessions);
        res.json({
            status: 'success',
            gameCode,
            bigram: MarkovAnalyzer.predictNext(digits),
            trigram: MarkovAnalyzer.predictNGram(digits, 3),
            quadgram: MarkovAnalyzer.predictNGram(digits, 4),
            transitionMatrix: MarkovAnalyzer.buildTransitionMatrix(digits)
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Heat score
app.get('/api/heat/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 20);
        const digits = DataNormalizer.extractAllDigits(sessions);
        const heat = StatisticsEngine.computeHeatScore(digits);
        const sorted = Object.entries(heat).sort((a, b) => b[1] - a[1]);
        res.json({
            status: 'success',
            gameCode,
            heatScore: heat,
            xepHangHeat: sorted.map(([d, s]) => ({ digit: d, score: s }))
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Genetic optimizer
app.get('/api/genetic/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 20);
        const digits = DataNormalizer.extractAllDigits(sessions);
        const heat = StatisticsEngine.computeHeatScore(digits);
        const evolved = GeneticOptimizer.evolve(heat, 25, 50);
        res.json({ status: 'success', gameCode, toiUuHoa: evolved });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Cache stats
app.get('/api/cache/stats', (req, res) => {
    res.json({ status: 'success', cache: apiCache.getStats() });
});

// Cache flush
app.post('/api/cache/flush', (req, res) => {
    apiCache.flush();
    res.json({ status: 'success', message: 'Cache flushed!' });
});

// Logs viewer
app.get('/api/logs', (req, res) => {
    const limit = Math.min(Utils.safeParseInt(req.query.limit, 50), 200);
    res.json({ status: 'success', logs: logger.history.slice(-limit) });
});

// 404
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        code: 404,
        message: 'API endpoint không tồn tại!',
        path: req.path
    });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err.message, err.stack);
    res.status(500).json({
        status: 'error',
        message: 'Lỗi server nội bộ',
        details: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
});

// ==================== 17. GRACEFUL SHUTDOWN ====================

const server = app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`🚀 ${CONFIG.SERVER_NAME} v${CONFIG.VERSION}`);
    console.log(`🌐 PORT: ${PORT}`);
    console.log(`📅 TIME: ${new Date().toLocaleString('vi-VN')}`);
    console.log(`⚡ ENDPOINTS: 15+ advanced analysis APIs`);
    console.log(`🧠 ALGORITHMS: Frequency, Heat, Markov, Bayes, Genetic`);
    console.log('═══════════════════════════════════════════════════════');
});

process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed.');
        process.exit(0);
    });
});

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION:', reason);
});

module.exports = app;
