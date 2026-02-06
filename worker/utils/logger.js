/**
 * Analytics Logger for Dev Console
 * Sends events to Cloudflare Analytics Engine
 */

// Event types
export const EventType = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

// Categories for filtering
export const Category = {
  AUTH: 'auth',
  MESSAGE: 'message',
  VOICE: 'voice',
  PUSH: 'push',
  SYNC: 'sync',
  PROFILE: 'profile',
  SOLANA: 'solana',
  SYSTEM: 'system',
};

/**
 * Log an event to Analytics Engine
 * 
 * @param {object} env - Worker environment with ANALYTICS binding
 * @param {object} options - Event options
 * @param {string} options.type - Event type (info, warn, error)
 * @param {string} options.category - Event category (auth, message, etc.)
 * @param {string} options.action - Specific action (verify, send, poll, etc.)
 * @param {string} [options.wallet] - Wallet pubkey (will be shortened)
 * @param {string} [options.details] - Additional details
 * @param {number} [options.latency] - Request latency in ms
 * @param {number} [options.status] - HTTP status code
 */
const DEV_LOG_KEY = 'dev_logs';
const MAX_DEV_LOGS = 500;

export function logEvent(env, options) {
  const {
    type = EventType.INFO,
    category = Category.SYSTEM,
    action = 'unknown',
    wallet = null,
    details = null,
    latency = 0,
    status = 200,
  } = options;

  const shortWallet = wallet ? `${wallet.slice(0, 4)}..${wallet.slice(-4)}` : '-';
  
  // Write to Analytics Engine if configured
  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        blobs: [type, category, action, shortWallet, details || '-'],
        doubles: [latency, status, 1],
        indexes: [category],
      });
    } catch (e) {
      console.error('[Logger] Analytics write failed:', e.message);
    }
  }
  
  // Also store in KV for dev console (async, non-blocking)
  if (env.SOLINK_KV) {
    storeDevLog(env, { type, category, action, wallet: shortWallet, details, latency, status }).catch(() => {});
  }
}

// Store log in KV for dev console real-time view
async function storeDevLog(env, logData) {
  try {
    const logsData = await env.SOLINK_KV.get(DEV_LOG_KEY, 'json') || [];
    
    logsData.unshift({
      ...logData,
      timestamp: Date.now(),
    });
    
    // Keep only last MAX_DEV_LOGS
    while (logsData.length > MAX_DEV_LOGS) {
      logsData.pop();
    }
    
    await env.SOLINK_KV.put(DEV_LOG_KEY, JSON.stringify(logsData));
  } catch (e) {
    // Silently fail
  }
}

/**
 * Create a logger instance bound to a specific request context
 */
export function createLogger(env, request) {
  const startTime = Date.now();
  
  return {
    info: (category, action, options = {}) => {
      logEvent(env, {
        type: EventType.INFO,
        category,
        action,
        latency: Date.now() - startTime,
        ...options,
      });
    },
    
    warn: (category, action, options = {}) => {
      logEvent(env, {
        type: EventType.WARN,
        category,
        action,
        latency: Date.now() - startTime,
        ...options,
      });
    },
    
    error: (category, action, options = {}) => {
      logEvent(env, {
        type: EventType.ERROR,
        category,
        action,
        latency: Date.now() - startTime,
        ...options,
      });
    },
  };
}

/**
 * Query events from Analytics Engine
 * Note: This requires the Analytics Engine SQL API
 * 
 * @param {object} env - Worker environment
 * @param {object} options - Query options
 * @returns {Promise<object>} Query results
 */
export async function queryEvents(env, options = {}) {
  const {
    period = '1h',          // 5m, 15m, 1h, 6h, 24h, 7d
    type = null,            // info, warn, error
    category = null,        // auth, message, etc.
    limit = 100,
    offset = 0,
  } = options;

  // Build time filter
  const timeFilters = {
    '5m': "timestamp > NOW() - INTERVAL '5' MINUTE",
    '15m': "timestamp > NOW() - INTERVAL '15' MINUTE",
    '1h': "timestamp > NOW() - INTERVAL '1' HOUR",
    '6h': "timestamp > NOW() - INTERVAL '6' HOUR",
    '24h': "timestamp > NOW() - INTERVAL '24' HOUR",
    '7d': "timestamp > NOW() - INTERVAL '7' DAY",
  };

  const timeFilter = timeFilters[period] || timeFilters['1h'];
  
  // Build WHERE conditions
  const conditions = [timeFilter];
  if (type) conditions.push(`blob1 = '${type}'`);
  if (category) conditions.push(`blob2 = '${category}'`);
  
  const whereClause = conditions.join(' AND ');

  // Query for events list
  const eventsQuery = `
    SELECT 
      timestamp,
      blob1 as type,
      blob2 as category,
      blob3 as action,
      blob4 as wallet,
      blob5 as details,
      double1 as latency,
      double2 as status
    FROM solink_events
    WHERE ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  // Query for stats
  const statsQuery = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN blob1 = 'error' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN blob1 = 'warn' THEN 1 ELSE 0 END) as warnings,
      AVG(double1) as avg_latency,
      COUNT(DISTINCT blob4) as unique_wallets
    FROM solink_events
    WHERE ${whereClause}
  `;

  // Query for category breakdown
  const breakdownQuery = `
    SELECT 
      blob2 as category,
      COUNT(*) as count
    FROM solink_events
    WHERE ${whereClause}
    GROUP BY blob2
    ORDER BY count DESC
  `;

  return { eventsQuery, statsQuery, breakdownQuery };
}

