// Landing page scripts
// Scroll to top on page load/reload
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
window.scrollTo(0, 0);

// Remove hash from URL without reload
if (window.location.hash) {
  history.replaceState(null, '', window.location.pathname);
}

document.addEventListener('DOMContentLoaded', () => {
  window.scrollTo(0, 0);
  
  // Hero nav blur on scroll
  const heroNav = document.querySelector('.hero-nav');
  if (heroNav) {
    const scrollThreshold = 100; // Start blur after 100px scroll
    
    const updateNavBlur = () => {
      const scrollY = window.scrollY;
      
      if (scrollY > scrollThreshold) {
        heroNav.classList.add('is-scrolled');
      } else {
        heroNav.classList.remove('is-scrolled');
      }
    };
    
    window.addEventListener('scroll', updateNavBlur, { passive: true });
    updateNavBlur(); // Check initial state
  }
  
  // Observer for sections
  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  });

  document.querySelectorAll('.partners-section__content').forEach(el => {
    sectionObserver.observe(el);
  });

  // Separate observer for individual elements - each triggers independently
  const elementObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -100px 0px'
  });

  // About block elements
  document.querySelectorAll('.about-block__header, .flow-diagram, .about-block__features').forEach(el => {
    elementObserver.observe(el);
  });

  // Token section elements
  document.querySelectorAll('.ts-token, .ts-roadmap, .ts-footer').forEach(el => {
    elementObserver.observe(el);
  });
});

