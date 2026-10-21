/**
 * =====================================================================
 * PROJECT: HOÀNG VIP WIN - ULTIMATE LOTTERY API & PREDICTION SERVER
 * VERSION: 6.0 (DETERMINISTIC ALGORITHM & FIXED)
 * AUTHOR: TRẦN NHẬT HOÀNG
 * DESC: Fixed JSON parsing + 100% Deterministic Math (NO RANDOM)
 * =====================================================================
 */

'use strict';

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
    SERVER_NAME: 'HOÀNG VIP WIN ENTERPRISE',
    VERSION: '6.0.0 DETERMINISTIC',
    API_BASE: 'https://k2d9u.k123b.club/api/front/open/lottery/history/list/game',
    CACHE_TTL_MS: 30000,
    REQUEST_TIMEOUT_MS: 15000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    GAME_DICTIONARY: {
        'st45g': 'XSMB 45 Giây',
        'st1p': 'XSMB 1 Phút',
        'bali': 'Bạc Liêu',
        'platvnk330s': 'Tài Xỉu 30 Giây',
        'st3p': 'XSMB 3 Phút',
        'st5p': 'XSMB 5 Phút'
    }
};

// ==================== SIMPLE CACHE & UTILS ====================
const cache = new Map();
const getCache = (key) => {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.time > CONFIG.CACHE_TTL_MS) { cache.delete(key); return null; }
    return item.data;
};
const setCache = (key, data) => cache.set(key, { time: Date.now(), data });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeInt = (val, fallback = 0) => {
    const n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
};
const calcSum = (arr) => arr.reduce((s, d) => s + safeInt(d), 0);
const getAverage = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const getMedian = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const getStdDev = (arr) => {
    if (arr.length < 2) return 0;
    const avg = getAverage(arr);
    return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / arr.length);
};

// ==================== FETCH LAYER ====================
async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            lastError = err;
            if (attempt < retries) await sleep(CONFIG.RETRY_DELAY_MS * attempt);
        }
    }
    throw lastError;
}

async function fetchLotteryData(gameCode, limitNum = 20) {
    const cacheKey = `lottery:${gameCode}:${limitNum}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const url = `${CONFIG.API_BASE}?limitNum=${limitNum}&gameCode=${gameCode}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://k123b.club/', // Fix chặn IP Render
        'Origin': 'https://k123b.club'
    };

    const json = await fetchWithRetry(url, { headers });
    setCache(cacheKey, json);
    return json;
}

// ==================== DATA PARSER (FIXED) ====================
async function getSessionsForGame(gameCode, limitNum = 20) {
    const rawJson = await fetchLotteryData(gameCode, limitNum);
    const issueList = rawJson.t?.issueList || rawJson.rows?.[0]?.issueList || [];

    return issueList.map((issue, idx) => {
        let details = [];
        try {
            details = typeof issue.detail === 'string' ? JSON.parse(issue.detail) : (issue.detail || []);
        } catch (e) { details = []; }

        let digits = [];
        details.forEach(d => {
            const clean = String(d).replace(/[^0-9]/g, '');
            digits.push(...clean.split(''));
        });

        const openNumClean = String(issue.openNum || '').replace(/[^0-9]/g, '');
        if (digits.length === 0 && openNumClean) {
            digits.push(...openNumClean.split(''));
        }

        const special = details[0] ? String(details[0]).replace(/[^0-9]/g, '') : openNumClean;

        return {
            index: idx,
            turnNum: issue.turnNum || `Kỳ_${idx + 1}`,
            openTime: issue.openTime || null,
            openNum: issue.openNum || null,
            detail: details,
            digits: digits,
            specialNumber: special,
            specialLast2: special.slice(-2),
            specialLast3: special.slice(-3),
            digitSum: calcSum(digits),
            head: digits[0] || null,
            tail: digits[digits.length - 1] || null
        };
    });
}

// ==================== STATISTICAL ENGINE (NO RANDOM) ====================

class StatisticalEngine {
    // 1. Tần suất xuất hiện (Frequency)
    static getFrequency(digits) {
        const map = {};
        digits.forEach(d => { map[d] = (map[d] || 0) + 1; });
        return map;
    }

    static rankByFrequency(freqMap) {
        return Object.entries(freqMap)
            .sort((a, b) => b[1] - a[1])
            .map(([digit, count]) => ({ digit, count }));
    }

    // 2. Trọng số làm mờ (Heat Score - Time Decay)
    // Số nào xuất hiện gần đây sẽ có trọng số cao hơn (Càng gần càng nóng)
    static computeHeatScore(digits, decayFactor = 0.85) {
        const heat = {};
        for (let d = 0; d <= 9; d++) heat[String(d)] = 0;

        // Duyệt từ cũ đến mới (gần nhất ở cuối)
        digits.forEach((digit, index) => {
            const recencyWeight = Math.pow(decayFactor, digits.length - 1 - index);
            heat[digit] += recencyWeight;
        });

        return heat;
    }

    // 3. Điểm Bayesian (Bayesian Inference - Laplace Smoothing)
    // Đo lường xác suất thực tế của từng số
    static computeBayesianScore(digits) {
        const total = digits.length || 1;
        const freq = this.getFrequency(digits);
        const scores = {};
        for (let d = 0; d <= 9; d++) {
            const count = freq[String(d)] || 0;
            // Công thức Laplace: P = (count + 1) / (total + 10)
            scores[String(d)] = (count + 1) / (total + 10);
        }
        return scores;
    }

    // 4. Markov Chain (Bigram) - Dự đoán số tiếp theo dựa trên số cuối cùng
    static predictMarkov(digits) {
        if (digits.length < 2) return [];
        const matrix = {};
        for (let i = 0; i < digits.length - 1; i++) {
            const current = digits[i];
            const next = digits[i + 1];
            if (!matrix[current]) matrix[current] = {};
            matrix[current][next] = (matrix[current][next] || 0) + 1;
        }

        const lastDigit = digits[digits.length - 1];
        const nextProbabilities = matrix[lastDigit] || {};
        const sum = Object.values(nextProbabilities).reduce((a, b) => a + b, 0) || 1;

        return Object.entries(nextProbabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([digit, count]) => ({ digit, probability: +(count / sum).toFixed(4) }));
    }
}

// ==================== PREDICTION ENGINE ====================

function runDeterministicPrediction(sessions, gameName) {
    if (!sessions || sessions.length === 0) {
        return { error: "Không có dữ liệu" };
    }

    const allDigits = sessions.flatMap(s => s.digits);
    const latestSession = sessions[0];

    // --- TẦNG 1: TÍNH TOÁN CÁC CHỈ SỐ CƠ BẢN ---
    const freqMap = StatisticalEngine.getFrequency(allDigits);
    const rankedFreq = StatisticalEngine.rankByFrequency(freqMap);
    const heatMap = StatisticalEngine.computeHeatScore(allDigits);
    const bayesMap = StatisticalEngine.computeBayesianScore(allDigits);
    const markovPredict = StatisticalEngine.predictMarkov(allDigits);

    // --- TẦNG 2: HỢP NHẤT ĐIỂM SỐ (ENSEMBLE WEIGHTING) ---
    // Trộn 3 phương pháp: Tần suất (30%), Heat (40%), Bayes (30%)
    const combinedScores = {};
    let totalScore = 0;

    for (let d = 0; d <= 9; d++) {
        const strD = String(d);
        const freqVal = (freqMap[strD] || 0) / (allDigits.length || 1);
        const heatVal = heatMap[strD] / (allDigits.length || 1);
        const bayesVal = bayesMap[strD];

        // Trọng số (Tổng = 1.0)
        const score = (freqVal * 0.3) + (heatVal * 0.4) + (bayesVal * 0.3);
        combinedScores[strD] = score;
        totalScore += score;
    }

    // Chuẩn hóa điểm về 0 - 100
    const finalRankedDigits = Object.entries(combinedScores)
        .map(([digit, score]) => ({ digit, score: (score / totalScore) * 100 }))
        .sort((a, b) => b.score - a.score);

    // --- TẦNG 3: CHỌN SỐ (KHÔNG RANDOM) ---
    const n1 = finalRankedDigits[0].digit;
    const n2 = finalRankedDigits[1].digit;
    const n3 = finalRankedDigits[2].digit;
    const n4 = finalRankedDigits[3].digit;

    const bachThuLo = `${n1}${n2}`;
    const songThuLo = [`${n2}${n1}`, `${n3}${n4}`];
    const loXien2 = [`${n1}${n3}`, `${n2}${n4}`];
    const loXien3 = [`${n1}${n2}${n3}`, `${n2}${n3}${n4}`];

    // --- TẦNG 4: TÍNH TOÁN ĐỘ TIN CẬY ---
    // Độ tin cậy = Độ lệch chuẩn của điểm số. 
    // Nếu các số top đầu có điểm rất sát nhau, độ tin cậy thấp (khó đoán).
    // Nếu số top 1 vượt trội hoàn toàn, độ tin cậy cao.
    const topScores = finalRankedDigits.slice(0, 3).map(x => x.score);
    const meanTop = getAverage(topScores);
    const stdDevTop = getStdDev(topScores);
    // Hệ số biến thiên (CV)
    const cv = meanTop > 0 ? (stdDevTop / meanTop) : 0;
    
    // Quy đổi ra % (Giới hạn từ 40% đến 99%)
    let confidence = 100 - (cv * 100);
    confidence = Math.max(40, Math.min(99, confidence));

    // --- TẦNG 5: DỰ ĐOÁN CHẠM VÀ TỔNG ĐỀ ---
    // Tính tổng giải Đặc biệt của 10 kỳ gần nhất
    const recentSpecialSums = sessions.slice(0, 10)
        .map(s => s.specialNumber ? calcSum(s.specialNumber.split('')) : 0)
        .filter(v => v > 0);

    const avgSpecialSum = getAverage(recentSpecialSums);
    const medianSpecialSum = getMedian(recentSpecialSums);

    // Lấy chạm dựa trên số nóng nhất
    const chamDe = `Chạm ${n1} (${finalRankedDigits[0].score.toFixed(1)}%)`;
    
    // Lấy tổng dựa trên trung vị gần nhất
    const tongDe = `Tổng ${Math.round(medianSpecialSum) % 10}`;

    return {
        tieuDe: "ÔNG VUA PHÂN TÍCH - DETERMINISTIC ALGORITHM",
        troChoi: gameName,
        phienThamChieu: latestSession.turnNum,
        thoiGianMoThuong: latestSession.openTime,
        ketQuaSoiCau: {
            bachThuLo,
            songThuLo: { con1: songThuLo[0], con2: songThuLo[1] },
            loXien2: { con1: loXien2[0], con2: loXien2[1] },
            loXien3: loXien3,
            chamDe,
            tongDe
        },
        phanTichNangCao: {
            topDigitsXepHang: finalRankedDigits.slice(0, 10),
            markovNextDigit: markovPredict.slice(0, 3).map(m => `${m.digit} (${(m.probability*100).toFixed(1)}%)`),
            doLechChuanKhoangCach: +stdDevTop.toFixed(3),
            doTinCayPhanTich: `${confidence.toFixed(1)}%`
        },
        meta: {
            soKyPhanTich: sessions.length,
            tongChuSoQuet: allDigits.length,
            thuatToanSuDung: "Ensemble: Frequency(30%) + Time-Decay Heat(40%) + Bayes(30%)",
            thoiGianPhanTich: new Date().toISOString()
        }
    };
}

// ==================== EXPRESS ROUTES ====================

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: CONFIG.SERVER_NAME,
        version: CONFIG.VERSION,
        message: '🔥 HOÀNG VIP WIN IS ACTIVE - NO RANDOM ALGORITHM 🔥',
        endpoints: {
            '/api/predict/:gameCode': 'Dự đoán VIP (Deterministic Math)',
            '/api/history/:gameCode': 'Lịch sử kết quả'
        }
    });
});

app.get('/api/history/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    try {
        const sessions = await getSessionsForGame(gameCode, 10);
        res.json({ status: 'success', gameCode, total: sessions.length, data: sessions });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/predict/:gameCode', async (req, res) => {
    const { gameCode } = req.params;
    const gameName = CONFIG.GAME_DICTIONARY[gameCode] || gameCode;

    try {
        // Lấy 20 kỳ gần nhất để phân tích
        const sessions = await getSessionsForGame(gameCode, 20);
        
        if (!sessions || sessions.length === 0) {
            return res.status(400).json({ 
                status: 'warning', 
                message: 'Không đủ dữ liệu từ API!' 
            });
        }

        const prediction = runDeterministicPrediction(sessions, gameName);
        res.json({ status: 'success', gameCode, duDoanVip: prediction });

    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Lỗi server!', details: err.message });
    }
});

// 404
app.use((req, res) => res.status(404).json({ status: 'error', message: 'Endpoint không tồn tại!' }));

// ==================== SERVER INIT ====================
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`🚀 ${CONFIG.SERVER_NAME} v${CONFIG.VERSION}`);
    console.log(`🌐 PORT: ${PORT}`);
    console.log(`🧠 ALGORITHM: Ensemble (Frequency + Heat + Bayes)`);
    console.log('═══════════════════════════════════════════════════════');
});
