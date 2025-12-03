/**
 * SOLINK Dev Console
 * Frontend for real-time monitoring
 */

(function() {
  'use strict';

  // ===================================
  // Configuration
  // ===================================
  
  const API_BASE = '/api/dev';
  const REFRESH_INTERVAL = 10000; // 10 seconds
  const EVENTS_PER_PAGE = 50;
  
  // ===================================
  // State
  // ===================================
  
  const state = {
    token: localStorage.getItem('dev_token') || null,
    filters: {
      period: '1h',
      type: '',
      category: '',
      search: '',
    },
    pagination: {
      offset: 0,
      limit: EVENTS_PER_PAGE,
      total: 0,
    },
    autoRefresh: true,
    refreshTimer: null,
    countdown: REFRESH_INTERVAL / 1000,
    charts: {
      timeline: null,
      categories: null,
      status: null,
    },
  };

  // ===================================
  // Chart Colors
  // ===================================
  
  const CHART_COLORS = {
    primary: '#3b82f6',
    success: '#22c55e',
    warning: '#eab308',
    error: '#ef4444',
    purple: '#8b5cf6',
    cyan: '#06b6d4',
    pink: '#ec4899',
    orange: '#f97316',
    gray: '#6b7280',
  };
  
  const CATEGORY_COLORS = {
    auth: CHART_COLORS.primary,
    message: CHART_COLORS.success,
    voice: CHART_COLORS.purple,
    push: CHART_COLORS.cyan,
    sync: CHART_COLORS.orange,
    profile: CHART_COLORS.pink,
    solana: CHART_COLORS.warning,
    system: CHART_COLORS.gray,
  };

  // ===================================
  // DOM Elements
  // ===================================
  
  const elements = {};
  
  function cacheElements() {
    elements.loginScreen = document.getElementById('login-screen');
    elements.consoleApp = document.getElementById('console-app');
    elements.loginForm = document.getElementById('login-form');
    elements.passwordInput = document.getElementById('password-input');
    elements.loginError = document.getElementById('login-error');
    
    elements.btnLogout = document.getElementById('btn-logout');
    elements.btnHealth = document.getElementById('btn-health');
    elements.btnRefresh = document.getElementById('btn-refresh');
    elements.btnClearFilters = document.getElementById('btn-clear-filters');
    elements.btnPrev = document.getElementById('btn-prev');
    elements.btnNext = document.getElementById('btn-next');
    
    elements.filterPeriod = document.getElementById('filter-period');
    elements.filterType = document.getElementById('filter-type');
    elements.filterCategory = document.getElementById('filter-category');
    elements.filterSearch = document.getElementById('filter-search');
    
    elements.eventsBody = document.getElementById('events-body');
    elements.emptyState = document.getElementById('empty-state');
    elements.loadingState = document.getElementById('loading-state');
    elements.paginationInfo = document.getElementById('pagination-info');
    
    elements.statTotal = document.getElementById('stat-total');
    elements.statSuccess = document.getElementById('stat-success');
    elements.statWarnings = document.getElementById('stat-warnings');
    elements.statErrors = document.getElementById('stat-errors');
    elements.statLatency = document.getElementById('stat-latency');
    elements.statWallets = document.getElementById('stat-wallets');
    
    elements.connectionStatus = document.getElementById('connection-status');
    elements.autoRefreshToggle = document.getElementById('auto-refresh-toggle');
    elements.refreshCountdown = document.getElementById('refresh-countdown');
  }

  // ===================================
  // API Functions
  // ===================================
  
  async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }
      
      return data;
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  }
  
  async function login(password) {
    const data = await apiRequest('/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    
    state.token = data.token;
    localStorage.setItem('dev_token', data.token);
    
    return data;
  }
  
  async function fetchStats() {
    const params = new URLSearchParams({
      period: state.filters.period,
    });
    
    return apiRequest(`/stats?${params}`);
  }
  
  async function fetchEvents() {
    const params = new URLSearchParams({
      period: state.filters.period,
      limit: state.pagination.limit,
      offset: state.pagination.offset,
    });
    
    if (state.filters.type) params.set('type', state.filters.type);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.search) params.set('search', state.filters.search);
    
    return apiRequest(`/events?${params}`);
  }

  // ===================================
  // UI Functions
  // ===================================
  
  function showLogin() {
    elements.loginScreen.classList.remove('hidden');
    elements.consoleApp.classList.add('hidden');
    elements.passwordInput.focus();
  }
  
  function showConsole() {
    elements.loginScreen.classList.add('hidden');
    elements.consoleApp.classList.remove('hidden');
    loadData();
    startAutoRefresh();
  }
  
  function logout() {
    state.token = null;
    localStorage.removeItem('dev_token');
    stopAutoRefresh();
    showLogin();
  }
  
  async function runHealthCheck() {
    const btn = elements.btnHealth;
    const originalText = btn.querySelector('span').textContent;
    
    btn.classList.add('loading');
    btn.querySelector('span').textContent = 'Checking...';
    
    try {
      const result = await apiRequest('/health');
      showHealthModal(result);
      
      // Refresh events to show new health check log
      loadData();
    } catch (error) {
      showHealthModal({ ok: false, error: error.message });
    } finally {
      btn.classList.remove('loading');
      btn.querySelector('span').textContent = originalText;
    }
  }
  
  function showHealthModal(result) {
    const modal = document.getElementById('health-modal');
    const body = document.getElementById('health-modal-body');
    const time = document.getElementById('health-modal-time');
    const title = modal.querySelector('.modal-title svg');
    
    // Update title color based on status
    title.style.color = result.ok ? 'var(--success)' : 'var(--error)';
    
    // Build body content
    let html = '';
    
    // Status banner
    if (result.ok) {
      html += `
        <div class="health-status health-status--ok">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22,4 12,14.01 9,11.01"/>
          </svg>
          All Systems Operational
        </div>
      `;
    } else if (result.error) {
      html += `
        <div class="health-status health-status--fail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          ${result.error}
        </div>
      `;
    } else {
      html += `
        <div class="health-status health-status--fail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Some Systems Failed
        </div>
      `;
    }
    
    // Results list
    if (result.results) {
      html += '<div class="health-results">';
      
      const icons = {
        kv: '💾',
        r2: '📦',
        do: '⚡',
        solana: '◎',
      };
      
      for (const [key, val] of Object.entries(result.results)) {
        const icon = icons[key] || '•';
        const badgeClass = val.status === 'ok' ? 'health-item-badge--ok' : 'health-item-badge--fail';
        
        html += `
          <div class="health-item">
            <span class="health-item-name">${icon} ${key}</span>
            <div class="health-item-status">
              <span class="health-item-badge ${badgeClass}">${val.status}</span>
              <span class="health-item-latency">${val.latency}ms</span>
            </div>
          </div>
        `;
      }
      
      html += '</div>';
    }
    
    body.innerHTML = html;
    time.textContent = result.totalLatency ? `Total: ${result.totalLatency}ms` : new Date().toLocaleTimeString();
    
    // Show modal
    modal.classList.remove('hidden');
  }
  
  function hideHealthModal() {
    document.getElementById('health-modal').classList.add('hidden');
  }
  
  function showLoading(show) {
    elements.loadingState.classList.toggle('hidden', !show);
    if (show) {
      elements.eventsBody.innerHTML = '';
      elements.emptyState.classList.add('hidden');
    }
  }
  
  function updateStats(stats) {
    const { total, errors, warnings, avgLatency, uniqueWallets } = stats;
    const success = total - errors - warnings;
    
    elements.statTotal.textContent = formatNumber(total);
    elements.statSuccess.textContent = formatNumber(success);
    elements.statWarnings.textContent = formatNumber(warnings);
    elements.statErrors.textContent = formatNumber(errors);
    elements.statLatency.textContent = avgLatency;
    elements.statWallets.textContent = formatNumber(uniqueWallets);
  }
  
  function renderEvents(events) {
    if (events.length === 0) {
      elements.eventsBody.innerHTML = '';
      elements.emptyState.classList.remove('hidden');
      return;
    }
    
    elements.emptyState.classList.add('hidden');
    
    const html = events.map(event => {
      const time = formatTime(event.timestamp);
      const typeClass = `type-badge--${event.type}`;
      const statusClass = event.status >= 400 ? 'status-badge--error' : 'status-badge--success';
      const walletClass = event.wallet === '-' ? 'event-wallet--empty' : '';
      
      const eventId = event.id || '-';
      
      return `
        <tr>
          <td><span class="event-time">${time}</span></td>
          <td><span class="type-badge ${typeClass}">${event.type}</span></td>
          <td><span class="event-category">${event.category}</span></td>
          <td><span class="event-action">${event.action}</span></td>
          <td><span class="event-wallet ${walletClass}">${event.wallet}</span></td>
          <td><span class="event-details" title="${escapeHtml(event.details || '')}">${event.details || '-'}</span></td>
          <td><span class="event-latency">${event.latency ? event.latency + 'ms' : '-'}</span></td>
          <td><span class="status-badge ${statusClass}">${event.status}</span></td>
          <td><span class="event-id" data-id="${eventId}" title="Click to copy">${eventId}</span></td>
        </tr>
      `;
    }).join('');
    
    elements.eventsBody.innerHTML = html;
    
    // Add click handlers for copying event IDs
    elements.eventsBody.querySelectorAll('.event-id').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (id && id !== '-') {
          navigator.clipboard.writeText(id).then(() => {
            el.textContent = 'copied!';
            setTimeout(() => {
              el.textContent = id;
            }, 1000);
          });
        }
      });
    });
  }
  
  function updatePagination() {
    const { offset, limit, total } = state.pagination;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + limit, total);
    
    elements.paginationInfo.textContent = `Showing ${start}-${end} of ${total} events`;
    elements.btnPrev.disabled = offset === 0;
    elements.btnNext.disabled = offset + limit >= total;
  }
  
  function setConnectionStatus(connected) {
    elements.connectionStatus.classList.toggle('disconnected', !connected);
    elements.connectionStatus.querySelector('.status-text').textContent = 
      connected ? 'Connected' : 'Disconnected';
  }

  // ===================================
  // Data Loading
  // ===================================
  
  async function loadData() {
    showLoading(true);
    
    try {
      const [statsData, eventsData] = await Promise.all([
        fetchStats(),
        fetchEvents(),
      ]);
      
      updateStats(statsData.stats);
      renderEvents(eventsData.events);
      
      // Update charts with all events (need to fetch more for charts)
      const allEventsData = await fetchAllEventsForCharts();
      updateCharts(allEventsData.events, statsData.stats, statsData.categories);
      
      state.pagination.total = eventsData.total;
      updatePagination();
      
      setConnectionStatus(true);
    } catch (error) {
      console.error('Failed to load data:', error);
      
      if (error.message === 'Unauthorized') {
        logout();
        showLoginError('Session expired. Please log in again.');
      } else {
        setConnectionStatus(false);
      }
    } finally {
      showLoading(false);
    }
  }
  
  async function fetchAllEventsForCharts() {
    // Fetch more events for accurate chart data
    const params = new URLSearchParams({
      period: state.filters.period,
      limit: 500,
      offset: 0,
    });
    
    return apiRequest(`/events?${params}`);
  }
  
  function showLoginError(message) {
    elements.loginError.textContent = message;
  }

  // ===================================
  // Auto Refresh
  // ===================================
  
  function startAutoRefresh() {
    if (!state.autoRefresh) return;
    
    stopAutoRefresh();
    state.countdown = REFRESH_INTERVAL / 1000;
    
    state.refreshTimer = setInterval(() => {
      state.countdown--;
      
      if (state.countdown <= 0) {
        state.countdown = REFRESH_INTERVAL / 1000;
        loadData();
      }
      
      updateCountdown();
    }, 1000);
    
    updateCountdown();
  }
  
  function stopAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    elements.refreshCountdown.textContent = '';
  }
  
  function updateCountdown() {
    if (state.autoRefresh && state.countdown > 0) {
      elements.refreshCountdown.textContent = `Next refresh in ${state.countdown}s`;
    } else {
      elements.refreshCountdown.textContent = '';
    }
  }

  // ===================================
  // Event Handlers
  // ===================================
  
  function setupEventHandlers() {
    // Login form
    elements.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = elements.passwordInput.value;
      
      if (!password) {
        showLoginError('Please enter a password');
        return;
      }
      
      try {
        await login(password);
        elements.passwordInput.value = '';
        showLoginError('');
        showConsole();
      } catch (error) {
        showLoginError(error.message || 'Invalid password');
      }
    });
    
    // Logout
    elements.btnLogout.addEventListener('click', logout);
    
    // Health Check
    elements.btnHealth.addEventListener('click', runHealthCheck);
    
    // Health Modal close handlers
    document.getElementById('health-modal-close').addEventListener('click', hideHealthModal);
    document.getElementById('health-modal-ok').addEventListener('click', hideHealthModal);
    document.getElementById('health-modal').addEventListener('click', (e) => {
      if (e.target.id === 'health-modal') hideHealthModal();
    });
    
    // Refresh
    elements.btnRefresh.addEventListener('click', () => {
      state.countdown = REFRESH_INTERVAL / 1000;
      loadData();
    });
    
    // Clear filters
    elements.btnClearFilters.addEventListener('click', () => {
      state.filters = { period: '1h', type: '', category: '', search: '' };
      elements.filterPeriod.value = '1h';
      elements.filterType.value = '';
      elements.filterCategory.value = '';
      elements.filterSearch.value = '';
      state.pagination.offset = 0;
      loadData();
    });
    
    // Filters
    elements.filterPeriod.addEventListener('change', (e) => {
      state.filters.period = e.target.value;
      state.pagination.offset = 0;
      loadData();
    });
    
    elements.filterType.addEventListener('change', (e) => {
      state.filters.type = e.target.value;
      state.pagination.offset = 0;
      loadData();
    });
    
    elements.filterCategory.addEventListener('change', (e) => {
      state.filters.category = e.target.value;
      state.pagination.offset = 0;
      loadData();
    });
    
    let searchTimeout;
    elements.filterSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.filters.search = e.target.value;
        state.pagination.offset = 0;
        loadData();
      }, 300);
    });
    
    // Pagination
    elements.btnPrev.addEventListener('click', () => {
      if (state.pagination.offset > 0) {
        state.pagination.offset -= state.pagination.limit;
        loadData();
      }
    });
    
    elements.btnNext.addEventListener('click', () => {
      if (state.pagination.offset + state.pagination.limit < state.pagination.total) {
        state.pagination.offset += state.pagination.limit;
        loadData();
      }
    });
    
    // Auto refresh toggle
    elements.autoRefreshToggle.addEventListener('change', (e) => {
      state.autoRefresh = e.target.checked;
      if (state.autoRefresh) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    });
  }

  // ===================================
  // Charts
  // ===================================
  
  function initCharts() {
    // Common chart options
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
      },
    };
    
    // Timeline chart (line)
    const timelineCtx = document.getElementById('chart-timeline').getContext('2d');
    state.charts.timeline = new Chart(timelineCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Requests',
            data: [],
            borderColor: CHART_COLORS.primary,
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 4,
          },
          {
            label: 'Errors',
            data: [],
            borderColor: CHART_COLORS.error,
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        ...commonOptions,
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
            },
            ticks: {
              color: '#71717a',
              font: { size: 10 },
              maxRotation: 0,
            },
          },
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
            },
            ticks: {
              color: '#71717a',
              font: { size: 10 },
              precision: 0,
            },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: '#a1a1aa',
              font: { size: 11 },
              boxWidth: 12,
              padding: 8,
            },
          },
        },
      },
    });
    
    // Categories chart (doughnut)
    const categoriesCtx = document.getElementById('chart-categories').getContext('2d');
    state.charts.categories = new Chart(categoriesCtx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: Object.values(CATEGORY_COLORS),
          borderWidth: 0,
        }],
      },
      options: {
        ...commonOptions,
        cutout: '65%',
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              color: '#a1a1aa',
              font: { size: 10 },
              boxWidth: 10,
              padding: 6,
            },
          },
        },
      },
    });
    
    // Status chart (doughnut)
    const statusCtx = document.getElementById('chart-status').getContext('2d');
    state.charts.status = new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['Success', 'Warnings', 'Errors'],
        datasets: [{
          data: [0, 0, 0],
          backgroundColor: [CHART_COLORS.success, CHART_COLORS.warning, CHART_COLORS.error],
          borderWidth: 0,
        }],
      },
      options: {
        ...commonOptions,
        cutout: '65%',
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              color: '#a1a1aa',
              font: { size: 10 },
              boxWidth: 10,
              padding: 6,
            },
          },
        },
      },
    });
  }
  
  function updateCharts(events, stats, categories) {
    // Update timeline chart
    if (state.charts.timeline && events.length > 0) {
      const timelineData = buildTimelineData(events);
      state.charts.timeline.data.labels = timelineData.labels;
      state.charts.timeline.data.datasets[0].data = timelineData.requests;
      state.charts.timeline.data.datasets[1].data = timelineData.errors;
      state.charts.timeline.update('none');
      
      // Update subtitle
      const subtitle = document.getElementById('chart-timeline-subtitle');
      if (subtitle) {
        const periodLabels = {
          '5m': 'Last 5 minutes',
          '15m': 'Last 15 minutes',
          '1h': 'Last hour',
          '6h': 'Last 6 hours',
          '24h': 'Last 24 hours',
        };
        subtitle.textContent = periodLabels[state.filters.period] || 'Last hour';
      }
    }
    
    // Update categories chart
    if (state.charts.categories && categories) {
      const categoryLabels = Object.keys(categories);
      const categoryData = Object.values(categories);
      const categoryColors = categoryLabels.map(cat => CATEGORY_COLORS[cat] || CHART_COLORS.gray);
      
      state.charts.categories.data.labels = categoryLabels;
      state.charts.categories.data.datasets[0].data = categoryData;
      state.charts.categories.data.datasets[0].backgroundColor = categoryColors;
      state.charts.categories.update('none');
    }
    
    // Update status chart
    if (state.charts.status && stats) {
      const success = stats.total - stats.errors - stats.warnings;
      state.charts.status.data.datasets[0].data = [success, stats.warnings, stats.errors];
      state.charts.status.update('none');
    }
  }
  
  function buildTimelineData(events) {
    // Determine bucket size based on period
    const periodMs = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    };
    
    const period = periodMs[state.filters.period] || periodMs['1h'];
    const bucketSize = period <= 15 * 60 * 1000 ? 60 * 1000 : // 1 min buckets for <=15m
                       period <= 60 * 60 * 1000 ? 5 * 60 * 1000 : // 5 min buckets for <=1h
                       period <= 6 * 60 * 60 * 1000 ? 30 * 60 * 1000 : // 30 min buckets for <=6h
                       60 * 60 * 1000; // 1 hour buckets for 24h
    
    const now = Date.now();
    const start = now - period;
    const buckets = new Map();
    
    // Initialize buckets
    for (let t = start; t <= now; t += bucketSize) {
      const key = Math.floor(t / bucketSize) * bucketSize;
      buckets.set(key, { requests: 0, errors: 0 });
    }
    
    // Fill buckets with event data
    events.forEach(event => {
      const key = Math.floor(event.timestamp / bucketSize) * bucketSize;
      if (buckets.has(key)) {
        buckets.get(key).requests++;
        if (event.type === 'error') {
          buckets.get(key).errors++;
        }
      }
    });
    
    // Convert to arrays
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    const labels = sortedKeys.map(ts => {
      const date = new Date(ts);
      if (bucketSize >= 60 * 60 * 1000) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    
    const requests = sortedKeys.map(key => buckets.get(key).requests);
    const errors = sortedKeys.map(key => buckets.get(key).errors);
    
    return { labels, requests, errors };
  }

  // ===================================
  // Utility Functions
  // ===================================
  
  function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
  
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===================================
  // Initialization
  // ===================================
  
  function init() {
    cacheElements();
    setupEventHandlers();
    initCharts();
    
    // Check for existing token
    if (state.token) {
      // Verify token is still valid
      fetchStats()
        .then(() => showConsole())
        .catch(() => {
          state.token = null;
          localStorage.removeItem('dev_token');
          showLogin();
        });
    } else {
      showLogin();
    }
  }
  
  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

