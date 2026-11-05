// Protects the endpoints that spend money or API credit: an optional access code,
// a per-IP hourly limit, and a global daily cap.
const crypto = require('crypto');

function sameCode(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createGuard() {
  const hits = new Map(); // key -> [timestamps]
  const daily = {}; // name -> { day, n }

  return function guard(name, { perHour, dailyCap }) {
    return (req, res, next) => {
      const code = process.env.ACCESS_CODE;
      if (code && !sameCode(req.get('x-access-code'), code)) {
        return res.status(401).json({ error: 'Enter the access code to use this feature.' });
      }
      const now = Date.now();
      const key = `${name}:${req.ip}`;
      const recent = (hits.get(key) || []).filter(t => now - t < 3600000);
      if (recent.length >= perHour) {
        return res.status(429).json({ error: `Limit reached: ${perHour} requests per hour for this feature. Try again later.` });
      }
      const today = new Date().toISOString().slice(0, 10);
      const d = daily[name] && daily[name].day === today ? daily[name] : (daily[name] = { day: today, n: 0 });
      const cap = Number(process.env[`DAILY_CAP_${name.toUpperCase()}`] || dailyCap);
      if (d.n >= cap) {
        return res.status(429).json({ error: 'The daily limit for this demo has been reached. Try again tomorrow.' });
      }
      recent.push(now);
      hits.set(key, recent);
      d.n++;
      next();
    };
  };
}

module.exports = { createGuard };