# Whismoke

Whismoke es una práctica de tienda online para una tienda ficticia de puros,
whisky y accesorios. Incluye tres páginas —inicio, tienda y contacto—
conectadas a una API PHP para gestionar cuentas, catálogo, cesta y pedidos.

## Tecnologías

- **HTML5** estructura las tres páginas y sus formularios.
- **CSS3** define el diseño adaptable y los estilos propios.
- **Bootstrap 5** aporta componentes de interfaz y utilidades de maquetación.
- **JavaScript** actualiza la interfaz y se comunica con la API mediante `fetch`.
- **PHP 8.1 o superior** sirve la aplicación y gestiona sesiones, usuarios, catálogo, stock, pedidos y mensajes.

## Páginas

| Página | Archivo | Función |
| --- | --- | --- |
| Inicio | `index.html` | Presentación y selección de productos destacados. |
| Tienda | `tienda.html` | Catálogo, filtros, búsqueda y cesta. |
| Contacto | `contacto.html` | Datos de contacto y formulario de consulta. |

## Requisitos

- PHP 8.1 o superior, disponible en la terminal como `php`.
- Un navegador moderno.

En Windows puedes instalar PHP 8.5 desde PowerShell con WinGet:

```powershell
winget install --id PHP.PHP.8.5 --exact --source winget --accept-source-agreements --accept-package-agreements
```

Cierra y vuelve a abrir PowerShell y comprueba la instalación con `php -v`. Si
Windows no reconoce el comando, comprueba que la carpeta de `php.exe` está en
`PATH` o ejecuta PHP con su ruta completa.

## Preparar y ejecutar la tienda

Desde PowerShell, en la carpeta raíz del proyecto:

```powershell
$env:WHIS_MOKE_ADMIN_EMAIL = "admin@whismoke.es"
$env:WHIS_MOKE_ADMIN_PASSWORD = "WhismokeAdmin2026!"
php api/setup.php
php -S localhost:8000
```

Mantén abierta esa terminal mientras uses la tienda y visita
<http://localhost:8000>. El servidor PHP sirve tanto las páginas como el
endpoint `api/index.php`, por lo que la sesión y las llamadas de JavaScript
funcionan en el mismo origen.

Ejecuta `php api/setup.php` solo la primera vez para crear el almacén y las
cuentas iniciales. El setup no sobrescribe un almacén existente. Si ya existe,
no cambia las contraseñas: conserva las credenciales de la primera
inicialización.

`WHIS_MOKE_ADMIN_EMAIL` es opcional; si no se define, el correo inicial es
`admin@whismoke.es`. La contraseña de administrador es obligatoria y debe tener
al menos 12 caracteres. `WHIS_MOKE_DATA_FILE` permite elegir otra ubicación
para el almacén JSON. Por defecto, se guarda en `whismoke-data/store.json`,
fuera de la carpeta pública del proyecto.

### Al clonar el proyecto en otro ordenador

PHP se instala en cada ordenador, no forma parte del repositorio y no se instala
al clonar desde GitHub. Si el equipo nuevo no tiene PHP, instala PHP 8.5 con el
comando de WinGet indicado arriba, vuelve a abrir PowerShell y comprueba la
instalación con `php -v`.

El almacén `whismoke-data/store.json` y las cuentas que crea el setup también son locales y están excluidos de Git. Por tanto, en cada ordenador nuevo:

1. Clona el repositorio y abre PowerShell en la carpeta del proyecto.
2. Instala PHP si todavía no está disponible.
3. Configura las variables y ejecuta `php api/setup.php` una vez para crear el almacén y las cuentas iniciales de ese ordenador.
4. Ejecuta `php -S localhost:8000` y visita <http://localhost:8000>.

La instalación de PHP permanece en ese ordenador, pero no se comparte con
GitHub. Las cuentas, pedidos, productos modificados y demás datos tampoco se
transfieren.

### Cuentas y sesiones

El setup crea estas cuentas locales:

| Perfil | Correo | Contraseña |
| --- | --- | --- |
| Comprador de prueba | `cliente@whismoke.es` | `WhismokeCliente2026!` |
| Administrador | `admin@whismoke.es` | `WhismokeAdmin2026!` |

El correo administrador se puede cambiar con `WHIS_MOKE_ADMIN_EMAIL`, pero si lo
haces también debes actualizar el valor de la tabla al iniciar sesión. Los
compradores pueden registrar otras cuentas desde la tienda. PHP guarda
contraseñas con `password_hash`, las verifica con `password_verify` y mantiene
la sesión en una cookie de PHP.

**Estas credenciales son públicas y solo sirven para desarrollo y defensa
local. No las uses en un servidor publicado ni con datos reales.** Cambia la
contraseña del administrador para cualquier instalación no local. El setup no
crea las cuentas de prueba si el almacén ya existía; para no arriesgar datos,
no borres el almacén automáticamente.

## Funciones implementadas

- Registro e inicio de sesión; el servidor asigna el rol comprador y solo el administrador puede gestionar la tienda.
- Edición del nombre y de la dirección de entrega en el perfil.
- Búsqueda, filtros por categoría y catálogo cargado desde la API.
- Añadir y retirar productos de la cesta. Cada reserva resta stock en el servidor; retirar la línea devuelve las unidades.
- No se permite reservar más unidades de las disponibles.
- Crear pedidos pendientes, consultar el historial y cancelar pedidos pendientes. La cancelación devuelve las unidades; aceptar un pedido conserva la reserva.
- El administrador puede aceptar pedidos, modificar precio y stock, añadir productos y eliminar productos sin reservas.
- El formulario de contacto guarda el mensaje en el almacén JSON local; no
  envía correos electrónicos.

Las páginas llaman a `api/index.php` desde el mismo origen. Las respuestas son
JSON y los errores HTTP se muestran en la interfaz. La cesta, los pedidos y el
stock se consultan de nuevo al servidor después de las operaciones para reflejar
los cambios persistidos.

Las acciones de la API incluyen `catalog`, `session`, `register`, `login`,
`logout`, `contact`, `profile`, `cart`, `cart-add`, `cart-remove`, `checkout`,
`orders`, `order-accept`, `order-cancel`, `product-add`, `product-save` y
`product-delete`.

## Catálogo

`assets/catalog.json` es el catálogo inicial que carga el setup. Cada producto
enlaza una imagen local de `media/`. La tienda obtiene los productos del
endpoint `catalog` y las altas y cambios de inventario se guardan en el almacén
del servidor.

Para cambiar los productos iniciales, edita el JSON y aumenta
`CATALOG_VERSION` en `api/index.php` y `api/setup.php`. Cuando una petición
detecta una versión diferente, la API vuelve a cargar los productos y elimina
las cestas y pedidos para que las reservas antiguas no contradigan el nuevo
stock; conserva los usuarios y mensajes. Esta migración afecta al almacén
existente, así que debe hacerse deliberadamente.

## Estructura

```text
Whismoke Shop/
├── index.html
├── tienda.html
├── contacto.html
├── assets/
│   ├── app.js
│   ├── styles.css
│   └── catalog.json
├── api/
│   ├── index.php
│   └── setup.php
├── media/
├── README.md
└── .gitignore
```

## Límites y despliegue

La interfaz y la API ya están conectadas, pero esta sigue siendo una práctica
educativa: el almacén JSON no sustituye a una base de datos para concurrencia y
crecimiento, y el servidor de desarrollo de PHP no es para producción. Antes de
publicar, configura HTTPS, revisa la seguridad de las sesiones y las peticiones
y usa un almacenamiento de producción. No publiques contraseñas, archivos de datos ni claves privadas.
