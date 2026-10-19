// ================================================================
// Letterlab — verwerking van nieuwe opnames
// ----------------------------------------------------------------
// Doet hetzelfde als de Audacity-macro 'Verwerking_fragmenten_TC',
// zodat nieuwe opnames even luid klinken als alle andere:
//
//   1. Normaliseren        DC-offset weg, piek op -1 dB
//   2. Loudness-normalisatie  -19 LUFS, mono telt als 'dual mono'
//   3. (Klik-verwijdering: niet nodig bij een microfoonopname)
//   4. Noise-gate          drempel -40 dB, attack/hold/decay 50 ms,
//                          daaronder volledig stil (-100 dB)
//
// Daarna wordt de stilte vooraan en achteraan ingekort, zodat een
// woord in het klik-klakboekje meteen begint. Alleen echte stilte (wat
// de noise-gate al stil maakte) gaat weg: de uitklank van een woord
// blijft volledig, met nog 0,3 s marge.
//
// Gebruik: LetterlabAudio.process(samples, sampleRate) → Float32Array
// ================================================================

(function (root) {
    "use strict";

    const SETTINGS = {
        peakDb: -1,
        lufs: -19,
        dualMono: true,
        gateThresholdDb: -40,
        gateAttackMs: 50,
        gateHoldMs: 50,
        gateDecayMs: 50,
        gateReductionDb: -100,
        keepBeforeMs: 100,
        keepAfterMs: 300,
        fadeMs: 20,
    };

    const dbToGain = (db) => Math.pow(10, db / 20);

    function peakOf(samples) {
        let peak = 0;
        for (let i = 0; i < samples.length; i += 1) {
            const value = Math.abs(samples[i]);
            if (value > peak) peak = value;
        }
        return peak;
    }

    function scale(samples, gain) {
        for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
    }

    // ---------- 1. Normaliseren ----------

    function removeDcOffset(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i];
        const mean = sum / Math.max(1, samples.length);
        for (let i = 0; i < samples.length; i += 1) samples[i] -= mean;
    }

    function normalizePeak(samples, db) {
        const peak = peakOf(samples);
        if (peak > 0) scale(samples, dbToGain(db) / peak);
    }

    // ---------- 2. Loudness (ITU-R BS.1770 / EBU R128) ----------

    function biquad(input, b0, b1, b2, a1, a2) {
        const output = new Float64Array(input.length);
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < input.length; i += 1) {
            const x = input[i];
            const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            output[i] = y;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
        }
        return output;
    }

    // K-filter: dezelfde formules als libebur128, voor elke samplefrequentie.
    function kWeight(samples, rate) {
        let f0 = 1681.974450955533;
        const gainDb = 3.999843853973347;
        let q = 0.7071752369554196;
        let k = Math.tan((Math.PI * f0) / rate);
        const vh = Math.pow(10, gainDb / 20);
        const vb = Math.pow(vh, 0.4996667741545416);
        let a0 = 1 + k / q + k * k;
        const shelf = biquad(
            samples,
            (vh + (vb * k) / q + k * k) / a0,
            (2 * (k * k - vh)) / a0,
            (vh - (vb * k) / q + k * k) / a0,
            (2 * (k * k - 1)) / a0,
            (1 - k / q + k * k) / a0,
        );
        f0 = 38.13547087602444;
        q = 0.5003270373238773;
        k = Math.tan((Math.PI * f0) / rate);
        a0 = 1 + k / q + k * k;
        return biquad(shelf, 1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0);
    }

    // Geïntegreerde luidheid in LUFS, met de gewone 'gating'.
    function integratedLoudness(samples, rate, dualMono) {
        const weighted = kWeight(samples, rate);
        const channels = dualMono ? 2 : 1;
        const block = Math.round(rate * 0.4);
        const step = Math.round(rate * 0.1);
        const powers = [];
        if (weighted.length >= block) {
            for (let start = 0; start + block <= weighted.length; start += step) {
                let sum = 0;
                for (let i = start; i < start + block; i += 1) sum += weighted[i] * weighted[i];
                powers.push((sum / block) * channels);
            }
        } else {
            // Korter dan 0,4 s (bv. een losse klank): het hele fragment telt.
            let sum = 0;
            for (let i = 0; i < weighted.length; i += 1) sum += weighted[i] * weighted[i];
            powers.push((sum / Math.max(1, weighted.length)) * channels);
        }
        const toLufs = (power) => -0.691 + 10 * Math.log10(power);
        const absolute = powers.filter((power) => power > 0 && toLufs(power) > -70);
        if (!absolute.length) return -Infinity;
        const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
        const relativeGate = toLufs(mean(absolute)) - 10;
        const gated = absolute.filter((power) => toLufs(power) > relativeGate);
        return toLufs(mean(gated.length ? gated : absolute));
    }

    function normalizeLoudness(samples, rate, lufs, dualMono) {
        const measured = integratedLoudness(samples, rate, dualMono);
        if (!Number.isFinite(measured)) return;
        scale(samples, dbToGain(lufs - measured));
    }

    // ---------- 4. Noise-gate ----------

    function noiseGate(samples, rate, options) {
        const threshold = dbToGain(options.gateThresholdDb);
        const closed = dbToGain(options.gateReductionDb);
        const attack = Math.max(1, Math.round((rate * options.gateAttackMs) / 1000));
        const hold = Math.round((rate * options.gateHoldMs) / 1000);
        const decay = Math.max(1, Math.round((rate * options.gateDecayMs) / 1000));
        const n = samples.length;

        // Afstand (in samples) tot het volgende en het vorige luide sample.
        const toNext = new Float64Array(n);
        let next = Infinity;
        for (let i = n - 1; i >= 0; i -= 1) {
            if (Math.abs(samples[i]) >= threshold) next = i;
            toNext[i] = next - i;
        }
        let last = -Infinity;
        for (let i = 0; i < n; i += 1) {
            if (Math.abs(samples[i]) >= threshold) last = i;
            const since = i - last;
            // De gate gaat al open vóór het geluid (attack), blijft open
            // tijdens 'hold' en sluit daarna geleidelijk (decay).
            const opening = toNext[i] <= attack ? 1 - toNext[i] / attack : 0;
            const closing = since <= hold ? 1 : since <= hold + decay ? 1 - (since - hold) / decay : 0;
            const open = Math.max(opening, closing);
            samples[i] *= closed + (1 - closed) * open;
        }
    }

    // ---------- Stilte vooraan en achteraan inkorten ----------

    function trimSilence(samples, rate, options) {
        const threshold = dbToGain(options.gateThresholdDb);
        let first = 0;
        while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
        let last = samples.length - 1;
        while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
        if (first >= samples.length) return samples;
        const start = Math.max(0, first - Math.round((rate * options.keepBeforeMs) / 1000));
        const end = Math.min(samples.length, last + 1 + Math.round((rate * options.keepAfterMs) / 1000));
        const cut = samples.slice(start, end);
        // Heel kort in- en uitfaden, zodat er nooit een tik hoorbaar is.
        const fade = Math.min(Math.round((rate * options.fadeMs) / 1000), Math.floor(cut.length / 2));
        for (let i = 0; i < fade; i += 1) {
            const gain = i / fade;
            cut[i] *= gain;
            cut[cut.length - 1 - i] *= gain;
        }
        return cut;
    }

    // ---------- Alles samen ----------

    function process(input, rate, overrides = {}) {
        const options = { ...SETTINGS, ...overrides };
        const samples = Float32Array.from(input);
        if (peakOf(samples) < 0.001) return null; // Er is niets te horen.

        removeDcOffset(samples);
        normalizePeak(samples, options.peakDb);
        normalizeLoudness(samples, rate, options.lufs, options.dualMono);

        // Een mp3 kan niet boven 0 dB: wat er toch boven zou komen,
        // wordt zacht begrensd in plaats van hard afgekapt.
        for (let i = 0; i < samples.length; i += 1) {
            const value = samples[i];
            const size = Math.abs(value);
            if (size > 0.9) {
                samples[i] = Math.sign(value) * (0.9 + 0.099 * Math.tanh((size - 0.9) / 0.099));
            }
        }

        noiseGate(samples, rate, options);
        return trimSilence(samples, rate, options);
    }

    root.LetterlabAudio = { process, integratedLoudness, SETTINGS };
})(typeof window !== "undefined" ? window : globalThis);
