/**
 * SOLINK Dev Console - Call Analytics
 */

(function() {
  'use strict';

  // ===================================
  // Configuration
  // ===================================
  
  const API_BASE = '/api/dev';
  const REFRESH_INTERVAL = 30000; // 30 seconds

  // ===================================
  // State
  // ===================================
  
  const state = {
    token: localStorage.getItem('dev_token') || null,
    period: '24h',
    autoRefresh: true,
    refreshTimer: null,
    countdown: REFRESH_INTERVAL / 1000,
    charts: {
      timeline: null,
      endReasons: null,
      duration: null,
      bandwidth: null,
    },
    walletsHidden: localStorage.getItem('dev_wallets_hidden') === 'true',
    filters: {
      status: '',
      reason: '',
      callId: '',
    },
    allCalls: [], // Store all calls for filtering
  };

  // ===================================
  // Chart Colors
  // ===================================
  
  const COLORS = {
    primary: '#3b82f6',
    success: '#22c55e',
    warning: '#eab308',
    error: '#ef4444',
    purple: '#8b5cf6',
    cyan: '#06b6d4',
    orange: '#f97316',
    pink: '#ec4899',
    gray: '#6b7280',
  };

  const END_REASON_COLORS = {
    ended_by_user: COLORS.success,
    completed: COLORS.success,
    rejected: COLORS.error,
    timeout: COLORS.warning,
    missed: COLORS.warning,
    disconnected: COLORS.orange,
    error: COLORS.error,
    max_duration: COLORS.purple,
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
    elements.btnRefresh = document.getElementById('btn-refresh');
    
    elements.callsBody = document.getElementById('calls-body');
    elements.emptyState = document.getElementById('empty-state');
    elements.loadingState = document.getElementById('loading-state');
    elements.callsCount = document.getElementById('calls-count');
    
    elements.connectionStatus = document.getElementById('connection-status');
    elements.autoRefreshToggle = document.getElementById('auto-refresh-toggle');
    elements.refreshCountdown = document.getElementById('refresh-countdown');
    elements.btnToggleWallets = document.getElementById('btn-toggle-wallets');
    
    // Filters
    elements.filterStatus = document.getElementById('filter-status');
    elements.filterReason = document.getElementById('filter-reason');
    elements.filterCallId = document.getElementById('filter-call-id');
    elements.btnClearFilters = document.getElementById('btn-clear-filters');
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
  
  async function fetchCallStats() {
    return apiRequest(`/call-stats?period=${state.period}`);
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
  
  function showLoading(show) {
    elements.loadingState.classList.toggle('hidden', !show);
    if (show) {
      elements.callsBody.innerHTML = '';
      elements.emptyState.classList.add('hidden');
    }
  }
  
  function showLoginError(message) {
    elements.loginError.textContent = message;
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
      const data = await fetchCallStats();
      
      updateStats(data.stats);
      updateCharts(data);
      
      // Store all calls for filtering
      state.allCalls = data.calls || [];
      applyFiltersAndRender();
      
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
  
  function updateStats(stats) {
    document.getElementById('stat-total-calls').textContent = stats.totalCalls || 0;
    document.getElementById('stat-successful').textContent = stats.successful || 0;
    document.getElementById('stat-failed').textContent = stats.failed || 0;
    document.getElementById('stat-avg-duration').textContent = formatDuration(stats.avgDuration || 0);
    document.getElementById('stat-total-time').textContent = formatDuration(stats.totalTalkTime || 0);
    document.getElementById('stat-unique-users').textContent = stats.uniqueUsers || 0;
    
    // Bandwidth stats
    document.getElementById('stat-egress').textContent = formatBytes(stats.egress || 0);
    document.getElementById('stat-ingress').textContent = formatBytes(stats.ingress || 0);
    
    elements.callsCount.textContent = `${stats.totalCalls || 0} calls`;
  }
  
  function applyFiltersAndRender() {
    let filtered = [...state.allCalls];
    
    // Filter by status
    if (state.filters.status === 'success') {
      filtered = filtered.filter(c => c.successful);
    } else if (state.filters.status === 'failed') {
      filtered = filtered.filter(c => !c.successful);
    }
    
    // Filter by end reason
    if (state.filters.reason) {
      filtered = filtered.filter(c => c.endReason === state.filters.reason);
    }
    
    // Filter by call ID
    if (state.filters.callId) {
      const searchTerm = state.filters.callId.toLowerCase();
      filtered = filtered.filter(c => 
        c.callId && c.callId.toLowerCase().includes(searchTerm)
      );
    }
    
    // Update filtered count
    const totalCount = state.allCalls.length;
    const filteredCount = filtered.length;
    if (totalCount !== filteredCount) {
      elements.callsCount.textContent = `${filteredCount} of ${totalCount} calls`;
    } else {
      elements.callsCount.textContent = `${totalCount} calls`;
    }
    
    renderCalls(filtered);
  }
  
  function renderCalls(calls) {
    if (calls.length === 0) {
      elements.callsBody.innerHTML = '';
      elements.emptyState.classList.remove('hidden');
      return;
    }
    
    elements.emptyState.classList.add('hidden');
    
    const html = calls.map(call => {
      const statusClass = call.successful ? 'call-status--success' : 
                          call.endReason === 'timeout' || call.endReason === 'missed' ? 'call-status--missed' :
                          'call-status--failed';
      const statusText = call.successful ? '✓ Connected' : '✗ Failed';
      
      // Hide wallets if toggle is enabled
      const callerDisplay = state.walletsHidden && call.caller 
        ? '<span class="wallet-hidden">••••••••</span>' 
        : (call.caller || '-');
      const calleeDisplay = state.walletsHidden && call.callee 
        ? '<span class="wallet-hidden">••••••••</span>' 
        : (call.callee || '-');
      
      return `
        <tr>
          <td><span class="call-time">${formatTime(call.timestamp)}</span></td>
          <td><span class="call-wallet" data-wallet="${call.caller || ''}">${callerDisplay}</span></td>
          <td><span class="call-wallet" data-wallet="${call.callee || ''}">${calleeDisplay}</span></td>
          <td><span class="call-duration">${formatDuration(call.duration || 0)}</span></td>
          <td><span class="call-status ${statusClass}">${statusText}</span></td>
          <td><span class="call-reason">${formatEndReason(call.endReason)}</span></td>
          <td><span class="call-id" title="Click to copy" data-id="${call.callId || ''}">${(call.callId || '-').slice(0, 8)}</span></td>
        </tr>
      `;
    }).join('');
    
    elements.callsBody.innerHTML = html;
    
    // Add click handlers for copying call IDs
    elements.callsBody.querySelectorAll('.call-id').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (id) {
          navigator.clipboard.writeText(id).then(() => {
            el.textContent = 'copied!';
            setTimeout(() => {
              el.textContent = id.slice(0, 8);
            }, 1000);
          });
        }
      });
    });
  }

  // ===================================
  // Wallet Privacy Toggle
  // ===================================
  
  function toggleWalletsVisibility() {
    state.walletsHidden = !state.walletsHidden;
    localStorage.setItem('dev_wallets_hidden', state.walletsHidden);
    updateWalletsToggleIcon();
    
    // Update all visible wallets
    document.querySelectorAll('.call-wallet').forEach(el => {
      const wallet = el.dataset.wallet;
      if (wallet && wallet !== '-' && wallet !== '') {
        el.innerHTML = state.walletsHidden 
          ? '<span class="wallet-hidden">••••••••</span>' 
          : wallet;
      }
    });
  }
  
  function updateWalletsToggleIcon() {
    if (!elements.btnToggleWallets) return;
    
    const eyeOpen = elements.btnToggleWallets.querySelector('.eye-open');
    const eyeClosed = elements.btnToggleWallets.querySelector('.eye-closed');
    
    if (state.walletsHidden) {
      eyeOpen.classList.add('hidden');
      eyeClosed.classList.remove('hidden');
      elements.btnToggleWallets.title = 'Show wallets';
    } else {
      eyeOpen.classList.remove('hidden');
      eyeClosed.classList.add('hidden');
      elements.btnToggleWallets.title = 'Hide wallets';
    }
  }

  // ===================================
  // Charts
  // ===================================
  
  function initCharts() {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
      },
    };
    
    // Timeline chart
    const timelineCtx = document.getElementById('chart-calls-timeline').getContext('2d');
    state.charts.timeline = new Chart(timelineCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Successful',
            data: [],
            borderColor: COLORS.success,
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Failed',
            data: [],
            borderColor: COLORS.error,
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: {
        ...commonOptions,
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#71717a', font: { size: 10 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#71717a', font: { size: 10 }, precision: 0 },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { color: '#a1a1aa', font: { size: 11 }, boxWidth: 12 },
          },
        },
      },
    });
    
    // End Reasons chart
    const reasonsCtx = document.getElementById('chart-end-reasons').getContext('2d');
    state.charts.endReasons = new Chart(reasonsCtx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
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
            labels: { color: '#a1a1aa', font: { size: 10 }, boxWidth: 10, padding: 6 },
          },
        },
      },
    });
    
    // Duration chart
    const durationCtx = document.getElementById('chart-duration').getContext('2d');
    state.charts.duration = new Chart(durationCtx, {
      type: 'bar',
      data: {
        labels: ['< 1m', '1-5m', '5-15m', '15-30m', '30m+'],
        datasets: [{
          data: [0, 0, 0, 0, 0],
          backgroundColor: [
            COLORS.cyan,
            COLORS.primary,
            COLORS.purple,
            COLORS.pink,
            COLORS.orange,
          ],
          borderRadius: 4,
        }],
      },
      options: {
        ...commonOptions,
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#71717a', font: { size: 10 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#71717a', font: { size: 10 }, precision: 0 },
          },
        },
      },
    });
    
    // Bandwidth chart
    const bandwidthCtx = document.getElementById('chart-bandwidth').getContext('2d');
    state.charts.bandwidth = new Chart(bandwidthCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Egress',
            data: [],
            borderColor: COLORS.primary,
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Ingress',
            data: [],
            borderColor: COLORS.orange,
            backgroundColor: 'rgba(249, 115, 22, 0.1)',
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: {
        ...commonOptions,
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#71717a', font: { size: 10 } },
          },
          y: {
            beginAtZero: true,
            min: 0,
            suggestedMax: 1024, // 1 KB minimum scale
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { 
              color: '#71717a', 
              font: { size: 10 },
              callback: (value) => formatBytes(value),
            },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { color: '#a1a1aa', font: { size: 11 }, boxWidth: 12 },
          },
        },
      },
    });
    
    // Show placeholder for bandwidth (no data available yet)
    showBandwidthPlaceholder();
  }
  
  function showBandwidthPlaceholder() {
    const chartContainer = document.getElementById('chart-bandwidth').parentElement;
    const placeholder = document.createElement('div');
    placeholder.id = 'bandwidth-placeholder';
    placeholder.className = 'chart-placeholder';
    placeholder.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; 
                  height: 100%; color: #71717a; font-size: 12px;">
        <span style="font-size: 24px; margin-bottom: 8px;">📊</span>
        <span>TURN bandwidth data requires</span>
        <span>Cloudflare API integration</span>
      </div>
    `;
    placeholder.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(24, 24, 27, 0.9); display: flex;';
    chartContainer.style.position = 'relative';
    chartContainer.appendChild(placeholder);
  }
  
  function updateCharts(data) {
    // Update timeline
    if (state.charts.timeline && data.timeline) {
      state.charts.timeline.data.labels = data.timeline.labels || [];
      state.charts.timeline.data.datasets[0].data = data.timeline.successful || [];
      state.charts.timeline.data.datasets[1].data = data.timeline.failed || [];
      state.charts.timeline.update('none');
      
      document.getElementById('chart-calls-subtitle').textContent = getPeriodLabel();
    }
    
    // Update end reasons
    if (state.charts.endReasons && data.endReasons) {
      const labels = Object.keys(data.endReasons);
      const values = Object.values(data.endReasons);
      const colors = labels.map(l => END_REASON_COLORS[l] || COLORS.gray);
      
      state.charts.endReasons.data.labels = labels.map(formatEndReason);
      state.charts.endReasons.data.datasets[0].data = values;
      state.charts.endReasons.data.datasets[0].backgroundColor = colors;
      state.charts.endReasons.update('none');
    }
    
    // Update duration distribution
    if (state.charts.duration && data.durationDistribution) {
      state.charts.duration.data.datasets[0].data = [
        data.durationDistribution['<1m'] || 0,
        data.durationDistribution['1-5m'] || 0,
        data.durationDistribution['5-15m'] || 0,
        data.durationDistribution['15-30m'] || 0,
        data.durationDistribution['30m+'] || 0,
      ];
      state.charts.duration.update('none');
    }
    
    // Update bandwidth
    if (state.charts.bandwidth && data.bandwidth) {
      const hasData = (data.bandwidth.egress || []).some(v => v > 0) || 
                      (data.bandwidth.ingress || []).some(v => v > 0);
      
      // Show/hide placeholder based on data availability
      const placeholder = document.getElementById('bandwidth-placeholder');
      if (placeholder) {
        placeholder.style.display = hasData ? 'none' : 'flex';
      }
      
      state.charts.bandwidth.data.labels = data.bandwidth.labels || [];
      state.charts.bandwidth.data.datasets[0].data = data.bandwidth.egress || [];
      state.charts.bandwidth.data.datasets[1].data = data.bandwidth.ingress || [];
      state.charts.bandwidth.update('none');
    }
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
    
    // Refresh
    elements.btnRefresh.addEventListener('click', () => {
      state.countdown = REFRESH_INTERVAL / 1000;
      loadData();
    });
    
    // Toggle Wallets Visibility
    if (elements.btnToggleWallets) {
      elements.btnToggleWallets.addEventListener('click', toggleWalletsVisibility);
      updateWalletsToggleIcon();
    }
    
    // Filters
    if (elements.filterStatus) {
      elements.filterStatus.addEventListener('change', (e) => {
        state.filters.status = e.target.value;
        applyFiltersAndRender();
      });
    }
    
    if (elements.filterReason) {
      elements.filterReason.addEventListener('change', (e) => {
        state.filters.reason = e.target.value;
        applyFiltersAndRender();
      });
    }
    
    if (elements.filterCallId) {
      let searchTimeout;
      elements.filterCallId.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          state.filters.callId = e.target.value;
          applyFiltersAndRender();
        }, 300);
      });
    }
    
    if (elements.btnClearFilters) {
      elements.btnClearFilters.addEventListener('click', () => {
        state.filters = { status: '', reason: '', callId: '' };
        elements.filterStatus.value = '';
        elements.filterReason.value = '';
        elements.filterCallId.value = '';
        applyFiltersAndRender();
      });
    }
    
    // Period tabs
    document.querySelectorAll('.period-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.period = tab.dataset.period;
        loadData();
      });
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
  // Utility Functions
  // ===================================
  
  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  
  function formatBytes(bytes) {
    // Handle edge cases: undefined, null, NaN, 0
    if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) {
      return '0 B';
    }
    
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    
    return `${value.toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
  }
  
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  
  function formatEndReason(reason) {
    const labels = {
      ended_by_user: 'Ended by user',
      completed: 'Completed',
      rejected: 'Rejected',
      timeout: 'No answer',
      missed: 'Missed',
      disconnected: 'Disconnected',
      error: 'Error',
      max_duration: 'Max duration',
    };
    return labels[reason] || reason || '-';
  }
  
  function getPeriodLabel() {
    const labels = {
      '1h': 'Last hour',
      '6h': 'Last 6 hours',
      '24h': 'Last 24 hours',
      '7d': 'Last 7 days',
      '30d': 'Last 30 days',
    };
    return labels[state.period] || 'Last 24 hours';
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
      fetchCallStats()
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

