<?php
declare(strict_types=1);

// Este inicializador solo debe ejecutarse desde la terminal; nunca expone un
// formulario web capaz de crear o reiniciar cuentas administrativas.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$email = strtolower(trim((string)(getenv('WHIS_MOKE_ADMIN_EMAIL') ?: 'admin@whismoke.es')));
$password = (string)(getenv('WHIS_MOKE_ADMIN_PASSWORD') ?: '');
if (
    !filter_var($email, FILTER_VALIDATE_EMAIL)
    || $email === 'cliente@whismoke.es'
    || strlen($password) < 12
) {
    fwrite(STDERR, "Define WHIS_MOKE_ADMIN_PASSWORD con al menos 12 caracteres y usa un correo válido distinto de cliente@whismoke.es.\n");
    exit(1);
}

// Los datos se guardan fuera del directorio público por defecto. La variable
// permite aislar instalaciones o pruebas con otro archivo de almacenamiento.
$dataFile = getenv('WHIS_MOKE_DATA_FILE') ?: dirname(__DIR__, 2) . '/whismoke-data/store.json';
$directory = dirname($dataFile);
if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
    fwrite(STDERR, "No se pudo crear el directorio de datos.\n");
    exit(1);
}
if (file_exists($dataFile)) {
    // No reemplazar un almacén evita perder cuentas, pedidos o stock existente.
    fwrite(STDERR, "Ya existe el archivo de datos. No se han modificado datos existentes.\n");
    exit(1);
}

$products = json_decode((string)file_get_contents(__DIR__ . '/../assets/catalog.json'), true, 512, JSON_THROW_ON_ERROR);
$store = [
    'catalog_version' => 4,
    // Las dos contraseñas se guardan como hashes; la contraseña inicial del
    // comprador es únicamente una credencial de demostración local.
    'users' => [
        [
            'id' => bin2hex(random_bytes(16)),
            'name' => 'Equipo Whismoke',
            'email' => $email,
            'role' => 'admin',
            'address' => '',
            'password' => password_hash($password, PASSWORD_DEFAULT),
        ],
        [
            'id' => bin2hex(random_bytes(16)),
            'name' => 'Cliente de prueba',
            'email' => 'cliente@whismoke.es',
            'role' => 'buyer',
            'address' => '',
            'password' => password_hash('WhismokeCliente2026!', PASSWORD_DEFAULT),
        ],
    ],
    'products' => $products,
    'orders' => [],
    'carts' => [],
    'messages' => [],
];

$encodedStore = json_encode(
    $store,
    JSON_PRETTY_PRINT
        | JSON_UNESCAPED_UNICODE
        | JSON_UNESCAPED_SLASHES
        | JSON_THROW_ON_ERROR
);
if (file_put_contents($dataFile, $encodedStore, LOCK_EX) === false) {
    fwrite(STDERR, "No se pudo escribir el catálogo inicial.\n");
    exit(1);
}

fwrite(STDOUT, "Catálogo inicial y cuentas de prueba creados. Administrador: {$email}; comprador: cliente@whismoke.es\n");