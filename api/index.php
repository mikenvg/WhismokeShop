<?php
declare(strict_types=1);

session_start();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

define('DATA_FILE', getenv('WHIS_MOKE_DATA_FILE') ?: dirname(__DIR__, 2) . '/whismoke-data/store.json');
define('CATALOG_VERSION', 4);

/**
 * Carga el catálogo inicial utilizado por setup y por las migraciones.
 */
function readCatalog(): array
{
    $catalog = json_decode((string)file_get_contents(__DIR__ . '/../assets/catalog.json'), true);
    if (!is_array($catalog)) {
        respond(['error' => 'No se pudo cargar el catálogo.'], 500);
    }
    return $catalog;
}

/**
 * Envía una respuesta JSON y termina la petición con el estado HTTP indicado.
 */
function respond(array $body, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Decodifica el cuerpo JSON de una petición de escritura.
 */
function readInput(): array
{
    $data = json_decode(file_get_contents('php://input') ?: '[]', true);
    return is_array($data) ? $data : [];
}

/**
 * Ejecuta una operación mientras mantiene bloqueado el almacén compartido.
 */
function withStore(callable $callback): mixed
{
    $directory = dirname(DATA_FILE);
    if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
        respond(['error' => 'No se pudo preparar el almacenamiento.'], 500);
    }

    $handle = fopen(DATA_FILE, 'c+');
    if ($handle === false || !flock($handle, LOCK_EX)) {
        respond(['error' => 'No se pudo bloquear el almacenamiento.'], 500);
    }

    // El bloqueo cubre todo el ciclo de lectura, modificación y escritura. Así,
    // dos peticiones no pueden reservar simultáneamente las mismas unidades.
    $contents = stream_get_contents($handle);
    $store = $contents ? json_decode($contents, true) : null;
    if (!is_array($store)) {
        $store = [];
    }
    $store = array_merge(['users' => [], 'products' => [], 'orders' => [], 'carts' => [], 'messages' => []], $store);
    if ((int)($store['catalog_version'] ?? 0) !== CATALOG_VERSION) {
        // Al cambiar el catálogo inicial se reinician reservas y pedidos para
        // que no queden cantidades ligadas a un inventario anterior.
        $store['products'] = readCatalog();
        $store['orders'] = [];
        $store['carts'] = [];
        $store['catalog_version'] = CATALOG_VERSION;
    }
    $result = $callback($store);
    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, json_encode($store, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $result;
}

/**
 * Elimina campos internos antes de devolver una cuenta al navegador.
 */
function safeUser(array $user): array
{
    // Nunca se devuelve al navegador la contraseña cifrada ni datos de avatar.
    unset($user['password'], $user['avatar']);
    return $user;
}

/**
 * Busca en el almacén la cuenta asociada a la sesión actual.
 */
function currentUser(array &$store): array
{
    $id = $_SESSION['user_id'] ?? null;
    foreach ($store['users'] as $user) {
        if ($user['id'] === $id) {
            return $user;
        }
    }
    respond(['error' => 'Inicia sesión para continuar.'], 401);
}

/**
 * Impide ejecutar una acción administrativa con una cuenta de comprador.
 */
function requireAdmin(array $user): void
{
    // Las comprobaciones de rol se hacen en el servidor, no solo en la interfaz.
    if (($user['role'] ?? '') !== 'admin') {
        respond(['error' => 'Esta acción requiere permisos de administración.'], 403);
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

// Las lecturas públicas se resuelven antes de exigir una sesión. El endpoint
// responde siempre con JSON y usa el código HTTP para indicar errores.
if ($action === 'catalog' && $method === 'GET') {
    $result = withStore(static function (array &$store): array {
        return ['products' => $store['products']];
    });
    respond($result);
}

if ($action === 'session' && $method === 'GET') {
    $result = withStore(static function (array &$store): array {
        foreach ($store['users'] as $user) {
            if ($user['id'] === ($_SESSION['user_id'] ?? null)) {
                return ['user' => safeUser($user)];
            }
        }
        return ['user' => null];
    });
    respond($result);
}

// El registro público siempre crea compradores. La cuenta administrativa se
// prepara por separado con api/setup.php.
if ($action === 'register' && $method === 'POST') {
    $input = readInput();
    $email = strtolower(trim((string)($input['email'] ?? '')));
    $name = trim((string)($input['name'] ?? ''));
    $password = (string)($input['password'] ?? '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $name === '' || strlen($password) < 8) {
        respond(['error' => 'Indica nombre, correo válido y contraseña de al menos 8 caracteres.'], 422);
    }
    $user = withStore(static function (array &$store) use ($email, $name, $password): array {
        foreach ($store['users'] as $existing) {
            if ($existing['email'] === $email) {
                respond(['error' => 'Ya existe una cuenta con ese correo.'], 409);
            }
        }
        $created = [
            'id' => bin2hex(random_bytes(16)),
            'name' => $name,
            'email' => $email,
            'role' => 'buyer',
            'address' => '',
            'password' => password_hash($password, PASSWORD_DEFAULT),
        ];
        $store['users'][] = $created;
        return $created;
    });
    // Cambiar el identificador de sesión al autenticar evita reutilizar el
    // identificador anónimo con privilegios de una cuenta.
    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    respond(['user' => safeUser($user)], 201);
}

if ($action === 'login' && $method === 'POST') {
    $input = readInput();
    $email = strtolower(trim((string)($input['email'] ?? '')));
    $password = (string)($input['password'] ?? '');
    $user = withStore(static function (array &$store) use ($email, $password): ?array {
        foreach ($store['users'] as $candidate) {
            if ($candidate['email'] === $email && password_verify($password, $candidate['password'])) {
                return $candidate;
            }
        }
        return null;
    });
    if ($user === null) {
        respond(['error' => 'Correo o contraseña incorrectos.'], 401);
    }
    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    respond(['user' => safeUser($user)]);
}

if ($action === 'logout' && $method === 'POST') {
    $_SESSION = [];
    session_destroy();
    respond(['ok' => true]);
}

if ($action === 'contact' && $method === 'POST') {
    $input = readInput();
    $name = trim((string)($input['name'] ?? ''));
    $email = trim((string)($input['email'] ?? ''));
    $message = trim((string)($input['message'] ?? ''));
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || $message === '') {
        respond(['error' => 'Completa nombre, correo y mensaje.'], 422);
    }
    withStore(static function (array &$store) use ($name, $email, $message, $input): void {
        $store['messages'][] = [
            'id' => bin2hex(random_bytes(12)),
            'name' => $name,
            'email' => $email,
            'topic' => trim((string)($input['topic'] ?? '')),
            'message' => $message,
            'created_at' => gmdate(DATE_ATOM),
        ];
    });
    respond(['ok' => true], 201);
}

// Desde aquí las acciones requieren una cuenta. Dentro del bloqueo se aplican
// las reglas de perfil, cesta, compra y administración sobre el mismo almacén.
$result = withStore(static function (array &$store) use ($action, $method): array {
    $user = currentUser($store);
    $input = readInput();
    if ($action === 'cart' && $method === 'GET') {
        $cart = $store['carts'][$user['id']] ?? [];
        return ['cart' => $cart, 'products' => $store['products']];
    }
    if ($action === 'profile' && $method === 'PATCH') {
        foreach ($store['users'] as &$candidate) {
            if ($candidate['id'] === $user['id']) {
                $name = trim((string)($input['name'] ?? $candidate['name']));
                $address = trim((string)($input['address'] ?? $candidate['address'] ?? ''));
                if ($name === '' || preg_match('/\A.{0,300}\z/us', $address) !== 1) {
                    respond(['error' => 'Revisa el nombre y la dirección de entrega.'], 422);
                }
                $candidate['name'] = $name;
                $candidate['address'] = $address;
                unset($candidate['avatar']);
                return ['user' => safeUser($candidate)];
            }
        }
    }
    if ($action === 'orders' && $method === 'GET') {
        $orders = [];
        foreach ($store['orders'] as $order) {
            if ($user['role'] === 'admin' || $order['user_id'] === $user['id']) {
                $orders[] = $order;
            }
        }
        return ['orders' => $orders];
    }
    // La cesta conserva identificadores y cantidades; el stock del producto
    // se actualiza al reservar o al retirar la línea.
    if ($action === 'cart-add' && $method === 'POST') {
        $productId = (string)($input['product_id'] ?? '');
        $quantity = max(1, min(20, (int)($input['quantity'] ?? 1)));
        foreach ($store['products'] as &$product) {
            if ($product['id'] !== $productId) {
                continue;
            }
            if ((int)$product['stock'] < $quantity) {
                respond(['error' => 'No hay unidades suficientes en stock.'], 409);
            }
            // Una reserva reduce existencias en la misma operación en que se
            // añade a la cesta; no se espera a la confirmación del pedido.
            $cart = $store['carts'][$user['id']] ?? [];
            $found = false;
            foreach ($cart as &$line) {
                if ($line['product_id'] === $productId) {
                    $line['quantity'] += $quantity;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                $cart[] = ['product_id' => $productId, 'quantity' => $quantity];
            }
            $product['stock'] -= $quantity;
            $store['carts'][$user['id']] = $cart;
            return ['cart' => $cart, 'product' => $product];
        }
        respond(['error' => 'Producto no encontrado.'], 404);
    }
    if ($action === 'cart-remove' && $method === 'POST') {
        $productId = (string)($input['product_id'] ?? '');
        $cart = $store['carts'][$user['id']] ?? [];
        foreach ($cart as $index => $line) {
            if ($line['product_id'] !== $productId) {
                continue;
            }
            foreach ($store['products'] as &$product) {
                if ($product['id'] === $productId) {
                    $product['stock'] += $line['quantity'];
                    break;
                }
            }
            array_splice($cart, $index, 1);
            $store['carts'][$user['id']] = $cart;
            return ['cart' => $cart];
        }
        return ['cart' => $cart];
    }
    if ($action === 'checkout' && $method === 'POST') {
        $cart = $store['carts'][$user['id']] ?? [];
        if (!$cart) {
            respond(['error' => 'La cesta está vacía.'], 422);
        }
        $address = trim((string)($user['address'] ?? ''));
        if ($address === '') {
            respond(['error' => 'Añade una dirección de entrega en tu perfil antes de realizar el pedido.'], 422);
        }
        $orderItems = [];
        foreach ($cart as $line) {
            foreach ($store['products'] as $product) {
                if ($product['id'] === $line['product_id']) {
                    $orderItems[] = [
                        'product_id' => $line['product_id'],
                        'quantity' => $line['quantity'],
                        'name' => $product['name'],
                        'price' => $product['price'],
                    ];
                    break;
                }
            }
        }
        $order = [
            'id' => 'WH-' . strtoupper(bin2hex(random_bytes(4))),
            'user_id' => $user['id'],
            'items' => $orderItems,
            'shipping_address' => $address,
            'status' => 'pending',
            'created_at' => gmdate(DATE_ATOM),
        ];
        // Las unidades ya se reservaron al añadirlas a la cesta. El checkout
        // conserva una instantánea del pedido y vacía la cesta sin descontar
        // stock por segunda vez.
        $store['orders'][] = $order;
        $store['carts'][$user['id']] = [];
        return ['order' => $order];
    }
    // Las acciones order-accept y order-cancel comparten validación de estado y
    // propiedad; solo la cancelación devuelve el stock reservado.
    if (preg_match('/^order-(cancel|accept)$/', $action, $matches) === 1 && $method === 'POST') {
        $cancel = $matches[1] === 'cancel';
        $orderId = (string)($input['order_id'] ?? '');
        if (!$cancel) {
            requireAdmin($user);
        }
        foreach ($store['orders'] as &$order) {
            if ($order['id'] !== $orderId) {
                continue;
            }
            $isAdministrator = $user['role'] === 'admin';
            $isOwner = $order['user_id'] === $user['id'];
            if ($order['status'] !== 'pending' || ($cancel && !$isAdministrator && !$isOwner)) {
                respond(['error' => 'No puedes modificar este pedido.'], 403);
            }
            $order['status'] = $cancel ? 'cancelled' : 'accepted';
            if ($cancel) {
                // Solo cancelar un pedido pendiente devuelve sus unidades. La
                // aceptación mantiene la reserva para completar la compra.
                foreach ($order['items'] as $line) {
                    foreach ($store['products'] as &$product) {
                        if ($product['id'] === $line['product_id']) {
                            $product['stock'] += $line['quantity'];
                            break;
                        }
                    }
                    unset($product);
                }
            }
            return ['order' => $order];
        }
        respond(['error' => 'Pedido no encontrado.'], 404);
    }
    if (in_array($action, ['product-save', 'product-add', 'product-delete'], true)) {
        // Ocultar el panel en el navegador no protege estas operaciones: cada
        // cambio del catálogo vuelve a comprobar el rol en el servidor.
        requireAdmin($user);
        if ($action === 'product-add' && $method === 'POST') {
            $name = trim((string)($input['name'] ?? ''));
            $category = (string)($input['category'] ?? '');
            $price = (float)($input['price'] ?? 0);
            $stock = (int)($input['stock'] ?? -1);
            $image = trim((string)($input['image'] ?? ''));
            $imageScheme = parse_url($image, PHP_URL_SCHEME);
            $validImageUrl = filter_var($image, FILTER_VALIDATE_URL) !== false
                && in_array($imageScheme, ['http', 'https'], true);
            $imagePath = dirname(__DIR__) . DIRECTORY_SEPARATOR
                . str_replace('/', DIRECTORY_SEPARATOR, $image);
            $validLocalImage = str_starts_with($image, 'media/')
                && !str_contains($image, '..')
                && is_file($imagePath);
            $validCategory = in_array(
                $category,
                ['Puros', 'Whisky', 'Miscelánea'],
                true
            );
            if ($name === '' || !$validCategory || $price <= 0 || $stock < 0) {
                respond(['error' => 'Revisa nombre, categoría, precio y stock.'], 422);
            }
            if ($image !== '' && !$validImageUrl && !$validLocalImage) {
                respond([
                    'error' => 'La imagen debe ser una URL HTTP/HTTPS o un archivo existente dentro de media/.',
                ], 422);
            }
            $product = [
                'id' => bin2hex(random_bytes(12)),
                'name' => $name,
                'category' => $category,
                'price' => $price,
                'stock' => $stock,
                'badge' => 'Nueva pieza',
                'description' => trim((string)($input['description'] ?? '')),
                'image' => $image,
            ];
            $store['products'][] = $product;
            return ['product' => $product];
        }
        $productId = (string)($input['product_id'] ?? '');
        foreach ($store['products'] as $index => &$product) {
            if ($product['id'] !== $productId) {
                continue;
            }
            if ($action === 'product-delete' && $method === 'POST') {
                // No se elimina un producto mientras una cesta o un pedido
                // pendiente dependa de él para devolver o mantener stock.
                $reserved = false;
                foreach ($store['carts'] as $cart) {
                    foreach ($cart as $line) {
                        if ($line['product_id'] === $productId) {
                            $reserved = true;
                            break 2;
                        }
                    }
                }
                foreach ($store['orders'] as $order) {
                    if ($order['status'] !== 'pending') {
                        continue;
                    }
                    foreach ($order['items'] as $line) {
                        if ($line['product_id'] === $productId) {
                            $reserved = true;
                            break 2;
                        }
                    }
                }
                if ($reserved) {
                    respond(['error' => 'No se puede eliminar un producto reservado.'], 409);
                }
                array_splice($store['products'], $index, 1);
                return ['ok' => true];
            }
            if ($action === 'product-save' && $method === 'PATCH') {
                $price = (float)($input['price'] ?? $product['price']);
                $stock = (int)($input['stock'] ?? $product['stock']);
                if ($price < 0 || $stock < 0) {
                    respond(['error' => 'Precio o stock inválido.'], 422);
                }
                $product['price'] = $price;
                $product['stock'] = $stock;
                return ['product' => $product];
            }
        }
        respond(['error' => 'Producto no encontrado.'], 404);
    }
    respond(['error' => 'Acción o método no válido.'], 404);
});

respond($result);