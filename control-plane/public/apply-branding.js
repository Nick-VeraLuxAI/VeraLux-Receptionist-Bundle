/**
 * Applies GET /api/branding to static shells. No build step — operators use BRAND_* env only.
 */
(function () {
  function apply(b, page) {
    if (!b || !page) return;

    var logos = document.querySelectorAll('.vlx-brand-logo');
    if (b.logoUrl) {
      logos.forEach(function (img) {
        img.src = b.logoUrl;
        img.alt = b.logoAlt || '';
        img.style.display = '';
      });
    } else {
      logos.forEach(function (img) {
        img.style.display = 'none';
      });
    }

    var brandName = b.logoAlt || 'VeraLux';

    if (page === 'admin' && b.admin) {
      if (b.admin.documentTitle) document.title = b.admin.documentTitle;
      var sub = document.getElementById('vlx-brand-subline');
      if (sub && b.admin.consoleSubline) sub.textContent = b.admin.consoleSubline;
    }
    if (page === 'portal' && b.portal) {
      if (b.portal.documentTitle) document.title = b.portal.documentTitle;
      var header = document.getElementById('vlx-portal-header-line');
      if (header && b.portal.headerLine) header.textContent = b.portal.headerLine;
      var tagline = document.getElementById('vlx-portal-tagline');
      if (tagline) {
        var tagText = b.portal.tagline || b.portal.headerLine;
        if (tagText) tagline.textContent = tagText;
      }
      var foot = document.getElementById('vlx-portal-footer-inner');
      if (foot) {
        if (b.portal.footerHtml) {
          foot.innerHTML = b.portal.footerHtml;
          foot.closest('footer') && (foot.closest('footer').style.display = '');
        } else {
          var f = foot.closest('footer');
          if (f) f.style.display = 'none';
        }
      }
    }
    if (page === 'owner' && b.owner) {
      if (b.owner.documentTitle) document.title = b.owner.documentTitle;
      var ownerBannerTitle = document.getElementById('vlx-owner-internal-banner-title');
      if (ownerBannerTitle) {
        ownerBannerTitle.textContent =
          b.owner.internalBannerTitle ||
          'Internal setup tool — ' + brandName + ' implementers only';
      }
      var ownerBannerCopy = document.getElementById('vlx-owner-internal-banner-copy');
      if (ownerBannerCopy && b.owner.internalBannerCopy) {
        ownerBannerCopy.textContent = b.owner.internalBannerCopy;
      }
    }
  }

  function run() {
    var page = document.body && document.body.getAttribute('data-vlx-branding-page');
    if (!page) return;
    fetch('/api/branding', { credentials: 'same-origin' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        apply(j, page);
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
