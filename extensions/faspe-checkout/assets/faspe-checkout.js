(() => {
  "use strict";

  if (window.__faspeCheckoutInitialized) return;
  window.__faspeCheckoutInitialized = true;

  const root = document.getElementById("faspe-checkout-root");
  if (!root) return;

  const bankLogo = (url, alt, fallback, color) => `
    <span class="faspe-bank-logo-box">
      <img
        class="faspe-bank-logo"
        src="${url}"
        alt="${alt}"
        loading="lazy"
        onerror="this.style.display='none';this.nextElementSibling.style.display='block';"
      >
      <span class="faspe-bank-fallback" style="color:${color}">${fallback}</span>
    </span>
  `;

  const bankGroup = (banks) => `
    <label class="faspe-bank-option">
      <input
        type="radio"
        name="faspeEmiBank"
        value="${banks.map((bank) => bank.name).join(", ")}"
      >
      <span class="faspe-bank-logo-group">
        ${banks.map((bank) =>
          bankLogo(bank.url, bank.name + " logo", bank.fallback, bank.color)
        ).join("")}
      </span>
    </label>
  `;

  root.innerHTML = `
    <div class="faspe-backdrop" data-faspe-close></div>

    <aside
      class="faspe-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="FasPe checkout"
      aria-hidden="true"
    >
      <header class="faspe-header">
        <div class="faspe-brand">
          <span class="faspe-title">Checkout</span>
          <span class="faspe-badge">FasPe</span>
        </div>
        <button
          type="button"
          class="faspe-close"
          aria-label="Close checkout"
          data-faspe-close
        >&times;</button>
      </header>

      <div class="faspe-content">
        <section>
          <h3 class="faspe-section-title">Payment Options</h3>

          <div class="faspe-payment-list">
            <button type="button" class="faspe-option" data-faspe-option="upi">
              <span class="faspe-option-row">
                <span class="faspe-option-main">
                  <span class="faspe-option-icon">⚡</span>
                  <span class="faspe-option-copy">
                    <span class="faspe-option-name">UPI (GPay, PhonePe, Paytm)</span>
                    <span class="faspe-option-description faspe-green">Flat ₹50 Instant Cashback</span>
                  </span>
                </span>
                <span class="faspe-chevron">›</span>
              </span>
            </button>

            <div class="faspe-emi-card">
              <button
                id="faspeEmiToggle"
                type="button"
                class="faspe-emi-toggle"
                aria-expanded="false"
                aria-controls="faspeEmiAccordion"
              >
                <span class="faspe-option-row">
                  <span class="faspe-option-main">
                    <span class="faspe-option-icon">💳</span>
                    <span class="faspe-option-copy">
                      <span class="faspe-option-name">Bank Credit / Debit Card EMI</span>
                      <span class="faspe-option-description faspe-amber">No-Cost EMI available for 3 &amp; 6 months</span>
                    </span>
                  </span>
                  <span id="faspeEmiArrow" class="faspe-emi-arrow">⌄</span>
                </span>
              </button>

              <div id="faspeEmiAccordion" class="faspe-emi-accordion" hidden>
                <p class="faspe-bank-heading">Select your bank</p>

                <div class="faspe-bank-grid">
                  ${bankGroup([
                    {
                      name: "ICICI Bank",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/ICICI_Bank_Logo.svg",
                      fallback: "ICICI",
                      color: "#b45309"
                    },
                    {
                      name: "HDFC Bank",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/HDFC_Bank_Logo.svg",
                      fallback: "HDFC",
                      color: "#174a91"
                    },
                    {
                      name: "Axis Bank",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Axis_Bank_logo.svg",
                      fallback: "AXIS",
                      color: "#6d28d9"
                    }
                  ])}

                  ${bankGroup([
                    {
                      name: "Federal Bank",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Federal_Bank_Logo.svg",
                      fallback: "FEDERAL",
                      color: "#047857"
                    },
                    {
                      name: "Canara Bank",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Canara_Bank_logo.svg",
                      fallback: "CANARA",
                      color: "#b91c1c"
                    },
                    {
                      name: "SBI",
                      url: "https://commons.wikimedia.org/wiki/Special:FilePath/State_Bank_of_India_logo.svg",
                      fallback: "SBI",
                      color: "#2563a6"
                    }
                  ])}

                  <label class="faspe-bank-option faspe-other-bank">
                    <input type="radio" name="faspeEmiBank" value="Other banks">
                    <span class="faspe-other-icon" aria-hidden="true">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <rect x="5" y="3" width="15" height="11" rx="2" stroke="#5145CD" stroke-width="1.7"/>
                        <rect x="3" y="7" width="15" height="11" rx="2" fill="#E8E5FF" stroke="#5145CD" stroke-width="1.7"/>
                        <path d="M3 11H18" stroke="#5145CD" stroke-width="1.7"/>
                        <path d="M6 15H10" stroke="#5145CD" stroke-width="1.7" stroke-linecap="round"/>
                      </svg>
                    </span>
                    <span class="faspe-other-label">Other banks</span>
                  </label>
                </div>

                <p id="faspeBankMessage" class="faspe-bank-message" role="status" aria-live="polite" hidden></p>
              </div>
            </div>

            <div class="faspe-option faspe-cardless" data-faspe-option="cardless">
              <div class="faspe-option-row">
                <span class="faspe-option-main">
                  <span class="faspe-option-icon">📑</span>
                  <span class="faspe-option-copy">
                    <span class="faspe-option-name">Cardless EMI</span>
                    <span class="faspe-option-description faspe-indigo">Zero down-payment options</span>
                  </span>
                </span>
                <span class="faspe-option-description faspe-indigo">Select</span>
              </div>
              <div class="faspe-juspay-tag">
                <strong>Powered by Juspay:</strong>
                Options available via <span class="faspe-underline">TVS Credit</span>,
                <span class="faspe-underline">Bajaj Finserv</span> &amp;
                <span class="faspe-underline">SaveIn</span>.
              </div>
            </div>

            <button type="button" class="faspe-option" data-faspe-option="cards">
              <span class="faspe-option-row">
                <span class="faspe-option-main">
                  <span class="faspe-option-icon">💳</span>
                  <span class="faspe-option-copy">
                    <span class="faspe-option-name">Credit / Debit Cards</span>
                    <span class="faspe-option-description">Visa, Mastercard, RuPay, Amex</span>
                  </span>
                </span>
                <span class="faspe-chevron">›</span>
              </span>
            </button>

            <button type="button" class="faspe-option" data-faspe-option="netbanking">
              <span class="faspe-option-row">
                <span class="faspe-option-main">
                  <span class="faspe-option-icon">🏦</span>
                  <span class="faspe-option-copy">
                    <span class="faspe-option-name">NetBanking</span>
                    <span class="faspe-option-description">All major Indian banks supported</span>
                  </span>
                </span>
                <span class="faspe-chevron">›</span>
              </span>
            </button>

            <button type="button" class="faspe-option" data-faspe-option="wallets">
              <span class="faspe-option-row">
                <span class="faspe-option-main">
                  <span class="faspe-option-icon">👛</span>
                  <span class="faspe-option-copy">
                    <span class="faspe-option-name">Wallets</span>
                    <span class="faspe-option-description">Mobikwik, Paytm Wallet, Amazon Pay</span>
                    <span class="faspe-option-description faspe-green">Get cashback up to ₹200 on Amazon Pay Balance</span>
                  </span>
                </span>
                <span class="faspe-chevron">›</span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <footer class="faspe-footer">
        <div class="faspe-pay-container">
          <button type="button" class="faspe-pay-button" id="faspePayButton">
            <span>Pay Net Amount</span>
            <span class="faspe-pay-amount" id="faspePayAmount">Loading total...</span>
          </button>
          <p class="faspe-secure">🔒 Secure Payment • Powered by CloudRight</p>
          <p class="faspe-secure" id="faspeDemoMessage" role="status" aria-live="polite" hidden></p>
        </div>
      </footer>
    </aside>
  `;

  const drawer = root.querySelector(".faspe-drawer");
  const backdrop = root.querySelector(".faspe-backdrop");
  const closeButtons = root.querySelectorAll("[data-faspe-close]");
  const emiToggle = root.querySelector("#faspeEmiToggle");
  const emiAccordion = root.querySelector("#faspeEmiAccordion");
  const emiArrow = root.querySelector("#faspeEmiArrow");
  const emiCard = root.querySelector(".faspe-emi-card");
  const bankMessage = root.querySelector("#faspeBankMessage");
  const demoMessage = root.querySelector("#faspeDemoMessage");
  const payButton = root.querySelector("#faspePayButton");
  const payAmount = root.querySelector("#faspePayAmount");

  let lastFocusedElement = null;
  let cartWasOpenBeforeCheckout = false;
  let cartOpenControl = null;

  // Fetch the actual total from the current Shopify cart.
  async function updateCartTotal() {
    payAmount.textContent = "Loading total...";

    try {
      const response = await fetch("/cart.js", {
        method: "GET",
        credentials: "same-origin",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("Unable to fetch Shopify cart.");
      }

      const cart = await response.json();

      if (
        typeof cart.total_price !== "number" ||
        !Number.isFinite(cart.total_price)
      ) {
        throw new Error("Shopify returned an invalid cart total.");
      }

      const currency = cart.currency || "INR";

      // Shopify returns prices in the currency's smallest unit.
      const amount = cart.total_price / 100;

      payAmount.textContent = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(amount);
    } catch (error) {
      payAmount.textContent = "Unable to load";
      console.error("FasPe: Could not update cart total.", error);
    }
  }

  const cartDrawerSelector = [
    "cart-drawer",
    "#CartDrawer",
    "#cart-drawer",
    ".cart-drawer",
    '[id*="CartDrawer"]',
    "[data-cart-drawer]"
  ].join(",");

  function isVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getAttribute("aria-hidden") !== "true" &&
      (
        element.classList.contains("active") ||
        element.classList.contains("is-open") ||
        element.classList.contains("open") ||
        element.classList.contains("animate") ||
        element.hasAttribute("open") ||
        element.open === true
      )
    );
  }

  function findCartOpenControl() {
    return document.querySelector([
      'button[aria-controls="CartDrawer"]',
      'button[aria-controls="cart-drawer"]',
      "[data-cart-toggle]",
      '[data-drawer-trigger="cart"]',
      '[data-action="open-cart"]',
      'button[name="open-cart"]',
      'a[href="/cart"]',
      'a[href$="/cart"]'
    ].join(","));
  }

  function findCartCloseControl(cartDrawer) {
    return cartDrawer.querySelector([
      'button[aria-label="Close cart"]',
      'button[aria-label="Close Cart"]',
      'button[aria-label="Close"]',
      'button[title="Close"]',
      ".drawer__close",
      ".cart-drawer__close",
      ".cart-drawer__close-button",
      "[data-cart-drawer-close]",
      "[data-close-cart]",
      ".icon-close"
    ].join(","));
  }

  function closeShopifyCartDrawer() {
    const cartDrawers = document.querySelectorAll(cartDrawerSelector);

    cartWasOpenBeforeCheckout = Array.from(cartDrawers).some((cartDrawer) => {
      if (root.contains(cartDrawer)) return false;

      const style = window.getComputedStyle(cartDrawer);

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        (
          cartDrawer.classList.contains("active") ||
          cartDrawer.classList.contains("is-open") ||
          cartDrawer.classList.contains("open") ||
          cartDrawer.classList.contains("animate") ||
          cartDrawer.hasAttribute("open") ||
          cartDrawer.getAttribute("aria-hidden") === "false"
        )
      );
    });

    // Remember the available cart control before closing the cart.
    cartOpenControl = findCartOpenControl();

    cartDrawers.forEach((cartDrawer) => {
      if (root.contains(cartDrawer)) return;

      const closeButton = findCartCloseControl(cartDrawer);

      if (closeButton) {
        closeButton.click();
      }

      if (
        cartDrawer.tagName.toLowerCase() === "cart-drawer" &&
        typeof cartDrawer.close === "function"
      ) {
        try {
          cartDrawer.close();
        } catch (error) {
          // The theme may already have closed this drawer.
        }
      }
    });

    // Ask the theme to close other open drawers before FasPe appears.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      })
    );
  }

  function reopenShopifyCartDrawer() {
    if (!cartWasOpenBeforeCheckout) return;

    cartWasOpenBeforeCheckout = false;

    window.setTimeout(() => {
      const cartDrawers = document.querySelectorAll(cartDrawerSelector);

      const alreadyOpen = Array.from(cartDrawers).some((cartDrawer) => {
        if (root.contains(cartDrawer)) return false;

        const style = window.getComputedStyle(cartDrawer);

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (
            cartDrawer.classList.contains("active") ||
            cartDrawer.classList.contains("is-open") ||
            cartDrawer.classList.contains("open") ||
            cartDrawer.hasAttribute("open") ||
            cartDrawer.getAttribute("aria-hidden") === "false"
          )
        );
      });

      if (alreadyOpen) return;

      let openControl = cartOpenControl;

      if (!openControl || !openControl.isConnected) {
        openControl = findCartOpenControl();
      }

      if (openControl) {
        openControl.click();
        return;
      }

      const cartDrawer = document.querySelector("cart-drawer");

      if (
        cartDrawer &&
        typeof cartDrawer.open === "function"
      ) {
        try {
          cartDrawer.open();
        } catch (error) {
          // Theme-specific drawer APIs may differ.
        }
      }
    }, 250);
  }

  function openCheckout() {
    lastFocusedElement = document.activeElement;

    closeShopifyCartDrawer();

    // Refresh the amount whenever the checkout drawer opens.
    updateCartTotal();

    root.style.setProperty("position", "relative");
    root.style.setProperty("z-index", "2147483644");

    backdrop.style.setProperty("z-index", "2147483645");
    drawer.style.setProperty("z-index", "2147483646");

    drawer.classList.add("is-open");
    backdrop.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");

    document.body.classList.add("faspe-checkout-open");

    const closeButton = root.querySelector(".faspe-close");

    if (closeButton) {
      closeButton.focus();
    }
  }

  function closeCheckout() {
    if (!drawer.classList.contains("is-open")) return;

    drawer.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");

    document.body.classList.remove("faspe-checkout-open");

    // Restore the Shopify cart only if it was open before FasPe.
    reopenShopifyCartDrawer();

    if (
      lastFocusedElement &&
      typeof lastFocusedElement.focus === "function"
    ) {
      lastFocusedElement.focus();
    }
  }

  closeButtons.forEach((button) => {
    button.addEventListener("click", closeCheckout);
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      drawer.classList.contains("is-open")
    ) {
      event.preventDefault();
      event.stopPropagation();
      closeCheckout();
    }
  });

  emiToggle.addEventListener("click", () => {
    const opening = emiAccordion.hidden;

    emiAccordion.hidden = !opening;
    emiToggle.setAttribute("aria-expanded", String(opening));
    emiArrow.classList.toggle("is-rotated", opening);
    emiCard.classList.toggle("is-expanded", opening);
  });

  root.querySelectorAll('input[name="faspeEmiBank"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      root.querySelectorAll(".faspe-bank-option").forEach((option) => {
        option.classList.toggle(
          "is-selected",
          option.contains(radio)
        );
      });

      bankMessage.textContent = radio.value + " selected for Card EMI.";
      bankMessage.hidden = false;
    });
  });

  root.querySelectorAll("[data-faspe-option]").forEach((option) => {
    option.addEventListener("click", () => {
      root.querySelectorAll("[data-faspe-option]").forEach((item) => {
        item.classList.toggle("is-selected", item === option);
      });
    });
  });

  payButton.addEventListener("click", () => {
    demoMessage.textContent =
      "Checkout preview only. A payment gateway has not been connected yet.";

    demoMessage.hidden = false;
  });

  // Intercept Shopify checkout buttons and links, including cart drawers.
  document.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const trigger = target.closest(
      'a[href="/checkout"], ' +
      'a[href^="/checkout?"], ' +
      'button[name="checkout"], ' +
      'input[name="checkout"], ' +
      'button[type="submit"][form*="cart"], ' +
      "[data-faspe-open-checkout]"
    );

    if (!trigger) return;

    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (
        trigger instanceof HTMLAnchorElement &&
        trigger.target === "_blank"
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    openCheckout();
  }, true);

  // Load the current cart amount when the script initializes.
  updateCartTotal();

  window.FasPeCheckout = {
    open: openCheckout,
    close: closeCheckout
  };
})();