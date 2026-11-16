(() => {
  "use strict";

  // La interfaz solo usa este endpoint; el estado persistente y las reglas de
  // stock, sesión y permisos pertenecen al servidor PHP.
  const API_URL = "api/index.php";

  // -- Utilidades de transporte, formato y estado de sesión --

  // Los datos del catálogo se insertan en plantillas HTML. Escapar cada valor
  // dinámico evita interpretar nombres o descripciones como marcado ejecutable.
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
  const money = (value) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value);
  const state = { products: [], cart: [], orders: [] };
  let currentUser = null;
  let selectedFilter = "Todos";
  let searchTerm = "";
  let authMode = "login";

  // Centraliza el formato JSON, las cookies de sesión y los errores HTTP para
  // que todos los flujos muestren los mensajes del servidor de la misma forma.
  async function apiRequest(action, options = {}) {
    const requestOptions = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {}
    };
    if (options.body !== undefined) {
      requestOptions.headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, requestOptions);
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("El servidor devolvió una respuesta no válida.");
    }
    if (!response.ok) {
      const error = new Error(result.error || "No se pudo completar la operación.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  // Convierte las propiedades de los pedidos del backend al formato de UI.
  function normalizeOrder(order) {
    // La API conserva nombres snake_case; la interfaz trabaja con camelCase.
    return {
      ...order,
      userId: order.user_id,
      shippingAddress: order.shipping_address,
      date: order.created_at,
      items: order.items.map((line) => ({
        ...line,
        productId: line.product_id
      }))
    };
  }

  // Recupera cesta e historial de la sesión activa; en modo anónimo los oculta.
  async function loadUserData() {
    if (!currentUser) {
      state.cart = [];
      state.orders = [];
      return;
    }
    const [cartResult, orderResult] = await Promise.all([
      apiRequest("cart"),
      apiRequest("orders")
    ]);
    // El servidor es la fuente de verdad: stock, cesta e historial se vuelven a
    // leer en lugar de confiar en una copia local que podría estar obsoleta.
    state.products = cartResult.products;
    state.cart = cartResult.cart.map((line) => ({
      productId: line.product_id,
      quantity: line.quantity
    }));
    state.orders = orderResult.orders.map(normalizeOrder);
  }

  // Arranque común a Inicio, Tienda y Contacto.
  async function initializeApp() {
    const [catalogResult, sessionResult] = await Promise.all([
      apiRequest("catalog"),
      apiRequest("session")
    ]);
    state.products = catalogResult.products;
    currentUser = sessionResult.user;
    await loadUserData();
    renderCatalog();
    renderCart();
  }

  async function refreshCatalog() {
    const result = await apiRequest("catalog");
    state.products = result.products;
  }

  // Actualiza en conjunto inventario, cesta e historial tras una mutación.
  async function refreshAccountData() {
    await refreshCatalog();
    await loadUserData();
    renderCatalog();
    renderCart();
  }

  async function runApiAction(action) {
    try {
      await action();
    } catch (error) {
      // Si la sesión expiró, se limpia la vista privada para no mostrar datos
      // de una cuenta que el servidor ya no reconoce.
      if (error.status === 401 && currentUser) {
        currentUser = null;
        state.cart = [];
        state.orders = [];
        renderCatalog();
        renderCart();
      }
      showToast(error.message);
    }
  }

  // Impide que el contador o la vista de cesta revelen datos sin sesión.
  function userCart() {
    return currentUser ? state.cart : [];
  }

  function ownedProductIds() {
    if (!currentUser) return new Set();
    // La etiqueta es una ayuda visual; la autorización real se valida en PHP.
    const orders = state.orders.filter((order) =>
      order.userId === currentUser.id && order.status !== "cancelled"
    );
    const productIds = orders.flatMap((order) =>
      order.items.map((item) => item.productId)
    );
    return new Set(productIds);
  }

  function showToast(message) {
    const element = document.getElementById("appToast");
    if (!element || !window.bootstrap) return;
    element.querySelector("[data-toast-message]").textContent = message;
    window.bootstrap.Toast.getOrCreateInstance(element, { delay: 3200 }).show();
  }

  function currentStock(product) {
    return Math.max(0, Number(product.stock) || 0);
  }

  // -- Renderizado de catálogo, cabecera, cesta y espacio de cuenta --

  function productCard(product) {
    const owned = ownedProductIds().has(product.id);
    const stock = currentStock(product);
    const badge = owned ? "En tus pedidos" : (stock < 1 ? "Sin stock" : product.badge);
    const stockLabel = stock > 0 ? `${stock} disponibles` : "Agotado";
    const buttonLabel = stock > 0
      ? '<i class="bi bi-plus-lg"></i> Añadir'
      : "Sin existencias";
    const disabled = stock < 1 ? "disabled" : "";

    return `
      <article class="product-card">
        <div class="product-image-wrap">
          <img
            class="product-image"
            src="${escapeHtml(product.image)}"
            alt="${escapeHtml(product.name)}"
            loading="eager"
          >
          <span class="product-badge ${owned ? "owned" : ""}">${escapeHtml(badge)}</span>
        </div>
        <div class="product-info">
          <div class="product-meta">
            <span>${escapeHtml(product.category)}</span>
            <span>${stockLabel}</span>
          </div>
          <h3>${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(product.description)}</p>
          <div class="product-buy-row">
            <span class="product-price">${money(product.price)}</span>
            <button
              class="add-button"
              type="button"
              data-action="add"
              data-product="${escapeHtml(product.id)}"
              ${disabled}
            >${buttonLabel}</button>
          </div>
        </div>
      </article>
    `;
  }

  // Aplica búsqueda y categoría antes de generar las dos vistas de productos.
  function renderCatalog() {
    const shopGrid = document.querySelector("[data-shop-products]");
    if (shopGrid) {
      const products = state.products.filter((product) => {
        const matchesCategory =
          selectedFilter === "Todos" || product.category === selectedFilter;
        const searchableText =
          `${product.name} ${product.category} ${product.description}`.toLocaleLowerCase("es");
        return matchesCategory && searchableText.includes(searchTerm);
      });
      shopGrid.innerHTML = products.map(productCard).join("");
      document.querySelector("[data-result-count]").textContent =
        `${products.length} ${products.length === 1 ? "pieza" : "piezas"}`;
      document.querySelector("[data-empty-products]").classList.toggle(
        "d-none",
        products.length > 0
      );
      document.querySelectorAll("[data-filter-count]").forEach((item) => {
        const category = item.dataset.filterCount;
        const count = category === "Todos"
          ? state.products.length
          : state.products.filter((product) => product.category === category).length;
        item.textContent = ` ${count}`;
      });
    }
    const featured = document.querySelector("[data-featured-products]");
    if (featured) {
      const featuredProducts = [
        ...state.products.filter((product) => product.category === "Puros").slice(0, 2),
        ...state.products.filter((product) => product.category === "Whisky").slice(0, 1),
        ...state.products.filter((product) => product.category === "Miscelánea").slice(0, 1)
      ];
      featured.innerHTML = featuredProducts.map(productCard).join("");
    }
    updateHeader();
  }

  function updateHeader() {
    const cartQuantity = userCart().reduce((sum, line) => sum + line.quantity, 0);
    document.querySelectorAll("[data-cart-count]").forEach((badge) => {
      badge.textContent = cartQuantity;
    });
    document.querySelectorAll("[data-cart-title-count]").forEach((label) => {
      label.textContent = `(${cartQuantity})`;
    });
    document.querySelectorAll("[data-user-control]").forEach((control) => {
      if (!currentUser) {
        control.innerHTML = '<i class="bi bi-person"></i><span>Acceder</span>';
        return;
      }
      const initial = escapeHtml(currentUser.name.charAt(0).toUpperCase());
      const firstName = escapeHtml(currentUser.name.split(" ")[0]);
      control.innerHTML = `
        <span class="avatar-fallback">${initial}</span>
        <span>${firstName}</span>
      `;
    });
  }

  // El contenido de la cesta es dinámico; el servidor valida todas sus acciones.
  function renderCart() {
    const container = document.getElementById("cartContent");
    if (!container) return;
    if (!currentUser) {
      container.innerHTML = `
        <div class="cart-empty">
          <i class="bi bi-person-lock"></i>
          Accede para empezar tu selección.
          <button class="button-dark mt-3" type="button" data-open-account>
            Iniciar sesión
          </button>
        </div>
      `;
      return;
    }
    const cart = userCart();
    if (!cart.length) {
      container.innerHTML = `
        <div class="cart-empty">
          <i class="bi bi-bag"></i>
          Tu cesta aún está vacía.
          <a class="button-dark mt-3" href="tienda.html">Explorar la tienda</a>
        </div>
      `;
      return;
    }
    const lines = cart.map((line) => {
      const product = state.products.find((item) => item.id === line.productId);
      if (!product) return "";
      return `
        <article class="cart-item">
          <img src="${escapeHtml(product.image)}" alt="">
          <div>
            <h3>${escapeHtml(product.name)}</h3>
            <p>${line.quantity} ud. · ${money(product.price)} c/u</p>
            <button
              class="remove-line"
              type="button"
              data-action="remove-line"
              data-product="${escapeHtml(product.id)}"
            >Quitar y devolver stock</button>
          </div>
          <span class="cart-item-price">${money(product.price * line.quantity)}</span>
        </article>
      `;
    }).join("");
    const total = cart.reduce((sum, line) => {
      const product = state.products.find((item) => item.id === line.productId);
      return sum + (product ? product.price : 0) * line.quantity;
    }, 0);
    const deliveryAddress = currentUser.address?.trim();
    const addressLabel = deliveryAddress
      ? "Editar dirección"
      : "Añadir dirección de entrega";

    container.innerHTML = `
      ${lines}
      <div class="cart-summary">
        <span>Subtotal</span>
        <span>${money(total)}</span>
      </div>
      <p class="cart-disclaimer">
        <strong>Dirección de entrega:</strong>
        ${deliveryAddress ? escapeHtml(deliveryAddress) : "Aún no indicada."}
      </p>
      <button class="remove-line" type="button" data-action="edit-address">${addressLabel}</button>
      <p class="cart-disclaimer">
        El stock se reserva al añadir y se repone si se cancela el pedido pendiente.
      </p>
      <button class="button-dark w-100" type="button" data-action="checkout">
        Realizar pedido <i class="bi bi-arrow-right"></i>
      </button>
    `;
  }

  // -- Flujos de comprador y administración --

  async function login(user) {
    currentUser = user;
    await loadUserData();
    renderCatalog();
    renderCart();
    bootstrap.Modal.getOrCreateInstance(document.getElementById("authModal")).hide();
    showToast(`Hola, ${user.name.split(" ")[0]}. Tu espacio está listo.`);
  }

  async function addToCart(productId) {
    if (!currentUser) {
      showToast("Inicia sesión para reservar una pieza.");
      openAccount();
      return;
    }
    const product = state.products.find((item) => item.id === productId);
    if (!product || currentStock(product) < 1) {
      showToast("Esta pieza no tiene unidades disponibles.");
      return;
    }
    await apiRequest("cart-add", {
      method: "POST",
      body: { product_id: productId, quantity: 1 }
    });
    await refreshAccountData();
    showToast(`${product.name} reservado. Stock actualizado.`);
  }

  async function removeCartLine(productId) {
    await apiRequest("cart-remove", {
      method: "POST",
      body: { product_id: productId }
    });
    await refreshAccountData();
    showToast("Producto quitado y unidades devueltas al stock.");
  }

  // La validación visual mejora el flujo; checkout vuelve a validar en PHP.
  async function submitOrder() {
    const cart = userCart();
    if (!currentUser || !cart.length) return;
    if (!currentUser.address?.trim()) {
      showToast("Añade una dirección de entrega para continuar.");
      editDeliveryAddress();
      return;
    }
    await apiRequest("checkout", { method: "POST", body: {} });
    await refreshAccountData();
    bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("cartPanel")).hide();
    showToast("Pedido enviado. Queda pendiente de aceptación Whismoke.");
  }

  function editDeliveryAddress() {
    const cartPanel = document.getElementById("cartPanel");
    // Bootstrap debe terminar de ocultar el panel antes de abrir el modal de
    // cuenta; de lo contrario, ambos overlays compiten por el foco y el fondo.
    cartPanel.addEventListener("hidden.bs.offcanvas", () => {
      void runApiAction(openAccount);
    }, { once: true });
    bootstrap.Offcanvas.getOrCreateInstance(cartPanel).hide();
  }

  async function cancelOrder(orderId) {
    await apiRequest("order-cancel", {
      method: "POST",
      body: { order_id: orderId }
    });
    await refreshAccountData();
    renderAccount("orders");
    showToast("Pedido cancelado; las unidades se repusieron al stock.");
  }

  async function openAccount() {
    if (!currentUser) {
      bootstrap.Modal.getOrCreateInstance(document.getElementById("authModal")).show();
      return;
    }
    await refreshAccountData();
    renderAccount("profile");
    bootstrap.Modal.getOrCreateInstance(document.getElementById("accountModal")).show();
  }

  // Se vuelve a consultar el servidor al cambiar de pestaña para mostrar datos
  // recientes, especialmente en las vistas de pedidos y administración.
  async function setAccountTab(tab) {
    document.querySelectorAll("[data-account-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.accountTab === tab);
      button.classList.toggle("d-none", button.dataset.accountTab === "admin" && currentUser.role !== "admin");
    });
    await refreshAccountData();
    renderAccount(tab);
  }

  function renderAccount(tab = "profile") {
    const content = document.getElementById("accountContent");
    if (!content || !currentUser) {
      return;
    }

    document.querySelector('[data-account-tab="admin"]').classList.toggle("d-none", currentUser.role !== "admin");

    if (tab === "profile") {
      renderProfile(content);
      return;
    }

    if (tab === "orders") {
      renderOrderHistory(content);
      return;
    }

    if (tab === "admin" && currentUser.role === "admin") {
      renderAdminPanel(content);
    }
  }

  // Cada renderizador recibe el contenedor y sustituye solo su contenido.
  function renderProfile(content) {
    const roleLabel = currentUser.role === "admin"
      ? "Administración"
      : "Cuenta comprador";
    const initial = escapeHtml(currentUser.name.charAt(0).toUpperCase());

    content.innerHTML = `
      <div class="profile-heading">
        <span class="profile-avatar avatar-fallback">${initial}</span>
        <div>
          <h3>Hola, ${escapeHtml(currentUser.name.split(" ")[0])}</h3>
          <p class="profile-email">${escapeHtml(currentUser.email)} · ${roleLabel}</p>
        </div>
      </div>
      <form class="profile-form" id="profileForm">
        <div>
          <label class="form-label" for="profileName">Nombre visible</label>
          <input
            class="form-control"
            id="profileName"
            name="name"
            value="${escapeHtml(currentUser.name)}"
            required
          >
        </div>
        <div>
          <label class="form-label" for="profileAddress">Dirección de entrega</label>
          <input
            class="form-control"
            id="profileAddress"
            name="address"
            type="text"
            autocomplete="street-address"
            maxlength="300"
            value="${escapeHtml(currentUser.address || "")}"
            placeholder="Calle, número, código postal y ciudad"
          >
        </div>
        <button class="button-dark mt-2" type="submit">
          Guardar perfil <i class="bi bi-check2"></i>
        </button>
      </form>
    `;
  }

  function renderOrderHistory(content) {
    const orders = currentUser.role === "admin"
      ? state.orders
      : state.orders.filter((order) => order.userId === currentUser.id);
    const title = currentUser.role === "admin" ? "Todos los pedidos" : "Mi historial";
    const orderContent = orders.length
      ? `<div class="order-list">${orders.map(orderRow).join("")}</div>`
      : `
        <div class="empty-account">
          Aún no tienes pedidos.<br>
          <a class="text-link mt-3" href="tienda.html">
            Descubrir la colección <i class="bi bi-arrow-up-right"></i>
          </a>
        </div>
      `;

    content.innerHTML = `<h3>${title}</h3>${orderContent}`;
  }

  function renderAdminPanel(content) {
    const pendingOrders = state.orders.filter((order) => order.status === "pending");
    const stockRows = state.products.map((product) => `
      <div class="admin-product-row">
        <span>${escapeHtml(product.name)}</span>
        <input
          aria-label="Precio de ${escapeHtml(product.name)}"
          type="number"
          min="0"
          step="0.01"
          value="${Number(product.price)}"
          data-admin-price="${escapeHtml(product.id)}"
        >
        <input
          aria-label="Stock de ${escapeHtml(product.name)}"
          type="number"
          min="0"
          step="1"
          value="${currentStock(product)}"
          data-admin-stock="${escapeHtml(product.id)}"
        >
        <button
          class="small-outline-button"
          type="button"
          data-action="save-product"
          data-product="${escapeHtml(product.id)}"
        >Guardar</button>
      </div>
    `).join("");
    const catalogRows = state.products.map((product) => `
      <div class="admin-product-row">
        <span>${escapeHtml(product.name)}</span>
        <span>${currentStock(product)} ud.</span>
        <span>${money(product.price)}</span>
        <button
          class="small-outline-button"
          type="button"
          data-action="delete-product"
          data-product="${escapeHtml(product.id)}"
        >Eliminar</button>
      </div>
    `).join("");
    const orderList = pendingOrders.length
      ? `<div class="order-list">${pendingOrders.map((order) => orderRow(order, true)).join("")}</div>`
      : '<p class="profile-email">No hay pedidos pendientes.</p>';

    content.innerHTML = `
      <div class="admin-section">
        <h3>Control de stock</h3>
        <p class="profile-email">
          El stock disminuye al reservar en cesta; cancelar devuelve las unidades.
        </p>
        ${stockRows}
      </div>
      <div class="admin-section">
        <h4>Añadir pieza</h4>
        <form class="product-form-grid" id="productForm">
          <input class="form-control" name="name" placeholder="Nombre del producto" required>
          <select class="form-select" name="category" required>
            <option value="Puros">Puros</option>
            <option value="Whisky">Whisky</option>
            <option value="Miscelánea">Miscelánea</option>
          </select>
          <input
            class="form-control"
            name="price"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Precio EUR"
            required
          >
          <input
            class="form-control"
            name="stock"
            type="number"
            min="0"
            step="1"
            placeholder="Unidades"
            required
          >
          <input
            class="form-control wide"
            name="description"
            placeholder="Descripción breve"
            required
          >
          <input
            class="form-control wide"
            name="image"
            type="text"
            placeholder="Ruta de imagen o URL (opcional)"
          >
          <button class="button-dark wide" type="submit">
            Añadir al catálogo <i class="bi bi-plus-lg"></i>
          </button>
        </form>
      </div>
      <div class="admin-section">
        <h4>Pedidos por aceptar (${pendingOrders.length})</h4>
        ${orderList}
      </div>
      <div class="admin-section">
        <h4>Catálogo</h4>
        ${catalogRows}
      </div>
    `;
  }

  // Los mismos datos de pedido se presentan en el historial y en administración.
  function orderRow(order, adminControls = false) {
    // Los pedidos guardan una copia de nombre y precio. La búsqueda en catálogo
    // solo sirve como alternativa para pedidos antiguos sin esos campos.
    const items = order.items.map((line) => {
      const product = state.products.find((item) => item.id === line.productId);
      return `${escapeHtml(line.name || product?.name || "Pieza retirada del catálogo")} × ${line.quantity}`;
    }).join(" · ");
    const total = order.items.reduce((sum, line) => {
      const product = state.products.find((item) => item.id === line.productId);
      return sum + Number(line.price ?? product?.price ?? 0) * line.quantity;
    }, 0);
    const status = { pending: "Pendiente", accepted: "Aceptado", cancelled: "Cancelado" }[order.status] || order.status;
    const date = new Intl.DateTimeFormat("es-ES", { dateStyle: "medium" }).format(new Date(order.date));
    let actions = "";
    if (order.status === "pending") {
      actions = adminControls
        ? `
          <div class="admin-order-actions">
            <button
              class="small-outline-button"
              type="button"
              data-action="accept-order"
              data-order="${escapeHtml(order.id)}"
            >Aceptar</button>
            <button
              class="small-outline-button"
              type="button"
              data-action="cancel-order"
              data-order="${escapeHtml(order.id)}"
            >Cancelar</button>
          </div>
        `
        : `
          <button
            class="small-outline-button"
            type="button"
            data-action="cancel-order"
            data-order="${escapeHtml(order.id)}"
          >Cancelar pedido</button>
        `;
    }
    return `
      <article class="order-row">
        <div class="order-topline">
          <span class="order-number">${escapeHtml(order.id)} · ${date}</span>
          <span class="order-status ${order.status === "cancelled" ? "cancelled" : ""}">
            ${status}
          </span>
        </div>
        <p class="order-items">${items}</p>
        <p class="order-address">
          <strong>Dirección de entrega:</strong>
          ${escapeHtml(order.shippingAddress || "No indicada")}
        </p>
        <div class="order-bottomline">
          <span>${money(total)}</span>
          ${actions}
        </div>
      </article>
    `;
  }

  // -- Eventos de interfaz: se delegan para seguir activos tras renderizar --

  function setupAuth() {
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        authMode = button.dataset.authMode;
        document.querySelectorAll("[data-auth-mode]").forEach((item) => {
          item.classList.toggle("selected", item === button);
        });

        const register = authMode === "register";
        const fields = document.querySelector(".register-fields");
        fields.classList.toggle("d-none", !register);
        fields.querySelectorAll("input").forEach((input) => {
          input.required = register;
        });

        const password = document.getElementById("authPassword");
        password.autocomplete = register ? "new-password" : "current-password";
        document.querySelector("[data-auth-submit]").innerHTML =
          `${register ? "Crear cuenta" : "Entrar"} <i class="bi bi-arrow-right"></i>`;
      });
    });

    document.getElementById("authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email")).trim().toLowerCase();
      const password = String(form.get("password"));

      if (authMode === "register" && password !== form.get("confirm")) {
        showToast("Las contraseñas no coinciden.");
        return;
      }

      const request = authMode === "register"
        ? {
            action: "register",
            body: {
              name: String(form.get("name")).trim(),
              email,
              password
            }
          }
        : { action: "login", body: { email, password } };

      await runApiAction(async () => {
        const result = await apiRequest(request.action, {
          method: "POST",
          body: request.body
        });
        await login(result.user);
      });
    });
  }

  // Los formularios y botones se generan dinámicamente; delegar eventos en
  // document permite que sigan funcionando después de volver a dibujar su HTML.
  document.addEventListener("click", (event) => {
    const accountButton = event.target.closest("[data-open-account]");
    if (accountButton) {
      void runApiAction(openAccount);
      return;
    }

    const filter = event.target.closest("[data-filter]");
    if (filter) {
      selectedFilter = filter.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((button) => {
        button.classList.toggle("active", button === filter);
      });
      renderCatalog();
      return;
    }

    const tab = event.target.closest("[data-account-tab]");
    if (tab && !tab.classList.contains("d-none")) {
      void runApiAction(() => setAccountTab(tab.dataset.accountTab));
      return;
    }

    const action = event.target.closest("[data-action]");
    if (!action) return;
    const { action: actionName, product: productId, order: orderId } = action.dataset;
    if (actionName === "edit-address") {
      editDeliveryAddress();
      return;
    }
    if (!currentUser && actionName !== "add") return;
    void runApiAction(async () => {
      if (actionName === "add") {
        await addToCart(productId);
      } else if (actionName === "remove-line") {
        await removeCartLine(productId);
      } else if (actionName === "checkout") {
        await submitOrder();
      } else if (actionName === "cancel-order") {
        await cancelOrder(orderId);
      } else if (actionName === "accept-order" && currentUser.role === "admin") {
        await apiRequest("order-accept", {
          method: "POST",
          body: { order_id: orderId }
        });
        await refreshAccountData();
        renderAccount("admin");
        showToast("Pedido aceptado.");
      } else if (actionName === "save-product" && currentUser.role === "admin") {
        const priceInput = document.querySelector(`[data-admin-price="${CSS.escape(productId)}"]`);
        const stockInput = document.querySelector(`[data-admin-stock="${CSS.escape(productId)}"]`);
        const price = Number(priceInput.value);
        const stock = Number(stockInput.value);

        if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
          showToast("Revisa el precio y el stock.");
          return;
        }

        await apiRequest("product-save", {
          method: "PATCH",
          body: { product_id: productId, price, stock }
        });
        await refreshAccountData();
        renderAccount("admin");
        showToast("Catálogo y stock actualizados.");
      } else if (actionName === "delete-product" && currentUser.role === "admin") {
        await apiRequest("product-delete", {
          method: "POST",
          body: { product_id: productId }
        });
        await refreshAccountData();
        renderAccount("admin");
        showToast("Producto eliminado del catálogo.");
      } else if (actionName === "logout") {
        await apiRequest("logout", { method: "POST", body: {} });
        currentUser = null;
        state.cart = [];
        state.orders = [];
        bootstrap.Modal.getOrCreateInstance(document.getElementById("accountModal")).hide();
        renderCatalog();
        renderCart();
        showToast("Has cerrado sesión.");
      }
    });
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-product-search]")) {
      searchTerm = event.target.value.trim().toLocaleLowerCase("es");
      renderCatalog();
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "profileForm") {
      event.preventDefault();
      const form = new FormData(event.target);
      const name = String(form.get("name")).trim();
      const address = String(form.get("address")).trim();
      if (address.length > 300) {
        showToast("La dirección no puede superar los 300 caracteres.");
        return;
      }

      void runApiAction(async () => {
        const result = await apiRequest("profile", {
          method: "PATCH",
          body: { name, address }
        });
        currentUser = result.user;
        await refreshAccountData();
        renderAccount("profile");
        showToast("Tu perfil se ha actualizado.");
      });
    }

    if (event.target.id === "productForm" && currentUser?.role === "admin") {
      event.preventDefault();
      const form = new FormData(event.target);
      const name = String(form.get("name")).trim();
      const price = Number(form.get("price"));
      const stock = Number(form.get("stock"));
      if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0) {
        showToast("Revisa el precio y el stock inicial.");
        return;
      }

      void runApiAction(async () => {
        await apiRequest("product-add", {
          method: "POST",
          body: {
            name,
            category: String(form.get("category")),
            price,
            stock,
            description: String(form.get("description")).trim(),
            image: String(form.get("image")).trim() || "media/miscelánea/misc1.avif"
          }
        });
        await refreshAccountData();
        renderAccount("admin");
        showToast("Nueva pieza añadida al catálogo.");
      });
    }
  });

  document.getElementById("contactForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = Object.fromEntries(new FormData(formElement));
    void runApiAction(async () => {
      await apiRequest("contact", { method: "POST", body: data });
      formElement.reset();
      const feedback = document.querySelector("[data-contact-feedback]");
      feedback.textContent = "Gracias por escribirnos. Hemos recibido tu mensaje y te responderemos pronto.";
      feedback.classList.remove("d-none");
    });
  });

  document.getElementById("authModal").addEventListener("show.bs.modal", () => {
    authMode = "login";
    document.querySelector('[data-auth-mode="login"]').click();
    document.getElementById("authForm").reset();
  });
  document.getElementById("cartPanel").addEventListener("show.bs.offcanvas", renderCart);
  setupAuth();
  renderCatalog();
  renderCart();
  // Se dibuja primero la estructura vacía y después se recupera sesión y datos;
  // la llamada inicial comparte el mismo tratamiento de errores que las demás.
  void runApiAction(initializeApp);
})();