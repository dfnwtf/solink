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
        </tr>
      `;
    }).join('');
    
    elements.eventsBody.innerHTML = html;
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

