# Angular i18n Translator

Herramienta CLI de Node.js para gestionar el flujo de trabajo de traducciones i18n en proyectos Angular mediante LLM (Large Language Models).

## Tabla de Contenidos

- [Descripcion](#descripcion)
- [Caracteristicas](#caracteristicas)
- [Requisitos Previos](#requisitos-previos)
- [Instalacion](#instalacion)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Configuracion](#configuracion)
- [Comandos](#comandos)
- [Flujo de Trabajo](#flujo-de-trabajo)
- [Proveedores LLM Soportados](#proveedores-llm-soportados)
- [Seguridad](#seguridad)
- [Solucion de Problemas](#solucion-de-problemas)

---

## Descripcion

**Angular i18n Translator** es una herramienta de linea de comandos que automatiza el proceso de traduccion de archivos XLF (XLIFF) utilizados en el sistema de internacionalizacion de Angular. Utiliza modelos de lenguaje (LLM) compatibles con la API de OpenAI para realizar traducciones de alta calidad, respetando interpolaciones, placeholders y formatos ICU.

### Flujo de trabajo

```
messages.xlf --> messages.csv --> batches/*.csv --> LLM Translation --> batches/translated/*.csv --> messages.translated.csv --> dist-i18n/*.xlf
```

---

## Caracteristicas

- **Conversion XLF a CSV**: Transforma archivos XLF de Angular a formato CSV para facilitar la edicion y traduccion
- **Traduccion con LLM**: Integracion con multiples proveedores de LLM (DeepSeek, OpenAI, Azure, Ollama, etc.)
- **Procesamiento por lotes**: Divide traducciones grandes en batches configurables para optimizar el uso de la API
- **Procesamiento secuencial de idiomas**: Los idiomas se procesan **secuencialmente** (uno a la vez) para evitar conflictos de archivos entre lotes traducidos
- **Procesamiento paralelo de batches**: Dentro de cada idioma, los batches se procesan en paralelo segun el parametro `concurrency`
- **Validacion completa**: Verifica interpolaciones, IDs duplicados y cobertura de traduccion
- **Reintentos automaticos**: Sistema de backoff exponencial para manejar errores de red y rate limiting
- **Preservacion de estructura**: Mantiene interpolaciones `{{variable}}`, placeholders `<x id="..."/>` y formatos ICU intactos

---

## Requisitos Previos

- **Node.js** >= 18.0.0 (requiere `fetch` nativo)
- **Clave API** de un proveedor LLM compatible (DeepSeek, OpenAI, Azure OpenAI, etc.)
- **Angular CLI** (para extraer las cadenas i18n con `ng extract-i18n`)

---

## Instalacion

### 1. Clonar o descargar el proyecto

```bash
cd angular-i18n-translator
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

```bash
# Copiar el archivo de ejemplo
cp .env.example .env

# Editar .env y anadir tu clave API
# LLM_API_KEY=tu-clave-api-aqui
```

### 4. Configurar idiomas

Edita `i18n.config.json` segun tus necesidades (ver seccion [Configuracion](#configuracion)).

---

## Estructura del Proyecto

```
angular-i18n-translator/
├── src/
│   ├── index.js          # Punto de entrada CLI y manejadores de comandos
│   ├── config.js         # Carga y validacion de configuracion
│   ├── xlf-parser.js     # Parser y generador de archivos XLF
│   ├── csv-converter.js  # Conversion entre XLF y CSV
│   ├── batch-manager.js  # Gestion de batches para traduccion
│   ├── llm-client.js     # Cliente HTTP para APIs LLM
│   ├── validator.js      # Validacion de CSV (interpolaciones, IDs, cobertura)
│   └── cleaner.js        # Limpieza de directorios generados
├── batches/
│   ├── pending/          # Batches pendientes de traducir
│   └── translated/       # Batches ya traducidos
├── dist-i18n/            # Archivos XLF traducidos (output)
├── .env.example          # Template de variables de entorno
├── .env                  # Variables de entorno (NO versionar)
├── .gitignore            # Archivos excluidos de Git
├── i18n.config.json      # Configuracion principal
├── messages.xlf          # Archivo XLF fuente (de Angular)
├── messages.csv          # CSV intermedio
├── messages.translated.csv # CSV con traducciones
├── package.json          # Dependencias y scripts npm
└── README.md             # Esta documentacion
```

---

## Configuracion

### Archivo `i18n.config.json`

```json
{
  "languages": [
    { "code": "en", "name": "English", "file": "messages.en.xlf" },
    { "code": "es", "name": "Spanish", "file": "messages.es.xlf" },
    { "code": "fr", "name": "French", "file": "messages.fr.xlf" }
  ],
  "sourceLanguage": "en",
  "sourceFile": "messages.xlf",
  "csvOutput": "messages.csv",
  "outputDir": "dist-i18n",
  "batchDir": "batches",
  "llm": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "${LLM_API_KEY}",
    "model": "deepseek-chat",
    "batchSize": 50,
    "concurrency": 5,
    "systemPrompt": "You are a professional translator..."
  }
}
```

### Descripcion de campos

| Campo | Tipo | Descripcion |
|-------|------|-------------|
| `languages` | Array | Lista de idiomas soportados con codigo, nombre y archivo de salida |
| `sourceLanguage` | String | Codigo del idioma origen (debe estar en `languages`) |
| `sourceFile` | String | Nombre del archivo XLF fuente extraido de Angular |
| `csvOutput` | String | Nombre del archivo CSV intermedio |
| `outputDir` | String | Directorio donde se guardan los XLF traducidos |
| `batchDir` | String | Directorio para almacenar los batches de traduccion |
| `llm.baseURL` | String | URL base de la API del proveedor LLM |
| `llm.apiKey` | String | Clave API (usar `${LLM_API_KEY}` para variable de entorno) |
| `llm.model` | String | Nombre del modelo a utilizar |
| `llm.batchSize` | Number | Registros por batch (default: 50) |
| `llm.concurrency` | Number | Batches simultaneos por idioma (default: 5) |
| `llm.systemPrompt` | String | Prompt del sistema para el LLM (opcional) |

---

## Comandos

### Comandos principales

| Comando | Descripcion |
|---------|-------------|
| `npm run extract` | Muestra el comando para extraer cadenas i18n de Angular |
| `npm run xlf-to-csv` | Convierte el archivo XLF a formato CSV |
| `npm run csv-to-xlf` | Convierte el CSV traducido a archivos XLF por idioma |
| `npm run translate:split` | Divide el CSV en batches para traduccion |
| `npm run translate:run` | Ejecuta la traduccion con LLM (idiomas en secuencia, batches en paralelo) |
| `npm run translate:merge` | Fusiona los batches traducidos en un CSV final |
| `npm run translate:all` | Ejecuta el pipeline completo de traduccion |
| `npm run validate` | Valida la consistencia del CSV |
| `npm run clean` | Limpia todos los archivos generados |

### Opciones adicionales

```bash
# Forzar re-traduccion de batches ya traducidos
npm run translate:run -- --force

# Limpiar solo archivos CSV
node src/index.js clean --csv-only

# Limpiar solo directorios de batches
node src/index.js clean --batches-only

# Limpiar solo directorio de salida
node src/index.js clean --output-only

# Limpiar batches y salida, mantener CSV
node src/index.js clean --keep-csv
```

---

## Flujo de Trabajo

### Paso 1: Extraer cadenas i18n de Angular

```bash
# Desde tu proyecto Angular
ng extract-i18n --output-path src/locale --out-file messages.xlf

# O para Angular 17+ con esbuild
ng extract-i18n --format xlf2 --output-path src/locale
```

Copia el archivo `messages.xlf` generado al directorio de esta herramienta.

### Paso 2: Convertir XLF a CSV

```bash
npm run xlf-to-csv
```

Esto genera `messages.csv` con columnas para cada idioma destino.

### Paso 3: Ejecutar traduccion completa (recomendado)

```bash
npm run translate:all
```

Este comando ejecuta automaticamente:
1. XLF a CSV
2. Division en batches
3. Traduccion con LLM (idiomas procesados **secuencialmente**, batches en paralelo)
4. Fusion de batches
5. CSV a XLF

> **Nota importante**: Los idiomas se procesan secuencialmente (uno despues de otro) para evitar conflictos en los archivos de batches traducidos. Dentro de cada idioma, los batches se procesan en paralelo segun el parametro `concurrency`.

### Alternativa: Ejecutar pasos individualmente

```bash
# 1. Dividir en batches
npm run translate:split

# 2. Ejecutar traduccion
npm run translate:run

# 3. Fusionar resultados
npm run translate:merge

# 4. Generar XLF finales
npm run csv-to-xlf
```

### Paso 4: Validar traducciones

```bash
npm run validate
```

### Paso 5: Copiar archivos traducidos

Los archivos XLF traducidos estan en `dist-i18n/`. Copialos a tu proyecto Angular:

```bash
cp dist-i18n/*.xlf tu-proyecto-angular/src/locale/
```

---

## Proveedores LLM Soportados

La herramienta es compatible con cualquier API que siga el formato OpenAI:

### DeepSeek (recomendado por costo)

```json
{
  "llm": {
    "baseURL": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### OpenAI

```json
{
  "llm": {
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### Azure OpenAI

```json
{
  "llm": {
    "baseURL": "https://tu-recurso.openai.azure.com/openai/deployments/tu-deployment",
    "model": "gpt-4",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### Ollama (local)

```json
{
  "llm": {
    "baseURL": "http://localhost:11434/v1",
    "model": "llama3.1",
    "apiKey": "ollama"
  }
}
```

### Otros proveedores compatibles

- **Groq**: `https://api.groq.com/openai/v1`
- **Anthropic** (via proxy compatible)
- **OpenRouter**: `https://openrouter.ai/api/v1`
- Cualquier API compatible con el formato OpenAI

---

## Seguridad

### Advertencias importantes

> **NUNCA** committees el archivo `.env` o cualquier archivo que contenga claves API.
>
> El archivo `.env` esta excluido de Git mediante `.gitignore`, pero debes verificar que nunca se incluya accidentalmente.

> **NUNCA** hardcodees claves API directamente en `i18n.config.json` si vas a versionar ese archivo.

### Mejores practicas

1. **Usa variables de entorno**: El archivo `.env` esta excluido de Git mediante `.gitignore`

2. **Referencia variables en config**: Usa la sintaxis `${LLM_API_KEY}` en `i18n.config.json`:
   ```json
   {
     "llm": {
       "apiKey": "${LLM_API_KEY}"
     }
   }
   ```

3. **Verifica antes de commit**: Asegurate de que `.env` no se incluya:
   ```bash
   git status
   # .env NO debe aparecer en la lista de archivos a committear
   ```

4. **Rota claves comprometidas**: Si accidentalmente committeas una clave, rotala inmediatamente desde el panel del proveedor.

5. **Usa claves con permisos minimos**: Limita las claves API solo a los permisos necesarios.

6. **Revisa el .gitignore**: Asegurate de que tu `.gitignore` incluya:
   ```gitignore
   # Environment variables (SECURITY - Never commit these!)
   .env
   .env.local
   .env.*.local
   ```

---

## Solucion de Problemas

### Error: "Configuration file not found"

**Causa**: No existe `i18n.config.json` en el directorio raiz.

**Solucion**: Crea el archivo de configuracion:
```bash
# Asegurate de estar en el directorio correcto
ls i18n.config.json
```

### Error: "LLM_API_KEY is not set" o "apiKey is empty"

**Causa**: La variable de entorno no esta configurada o el archivo `.env` no existe.

**Solucion**: 
```bash
# Verifica que .env existe y contiene la clave
cat .env
# Debe mostrar: LLM_API_KEY=tu-clave-aqui

# Si no existe, crealo:
cp .env.example .env
# Luego edita .env con tu clave real
```

### Error: "API error 401"

**Causa**: Clave API invalida o expirada.

**Solucion**: Verifica que la clave API sea correcta y tenga fondos/saldo.

### Error: "API error 429 - Rate limit"

**Causa**: Demasiadas solicitudes en poco tiempo.

**Solucion**: 
- Reduce `concurrency` en la configuracion
- Aumenta `batchSize` para hacer menos llamadas
- Espera unos minutos antes de reintentar

### Error: "Request timeout"

**Causa**: La API tarda demasiado en responder.

**Solucion**: 
- El timeout esta configurado en 60 segundos
- Verifica tu conexion a internet
- Intenta con un modelo mas rapido

### Las traducciones pierden interpolaciones

**Causa**: El LLM no sigue las instrucciones correctamente.

**Solucion**: 
- Verifica que el `systemPrompt` incluya instrucciones sobre interpolaciones
- Prueba con un modelo mas capaz (gpt-4o en lugar de gpt-3.5)
- Revisa el reporte de validacion: `npm run validate`

### Los archivos XLF no se generan correctamente

**Causa**: El CSV traducido tiene formato incorrecto.

**Solucion**:
1. Ejecuta validacion: `npm run validate`
2. Revisa `messages.translated.csv` manualmente
3. Asegurate de que todas las columnas de idiomas tengan contenido

### Error: "CSV file not found"

**Causa**: Falta ejecutar `xlf-to-csv` antes de otros comandos.

**Solucion**:
```bash
npm run xlf-to-csv
npm run translate:all
```

### Los batches no se procesan

**Causa**: No hay batches pendientes o ya estan traducidos.

**Solucion**:
```bash
# Forzar re-procesamiento
npm run translate:run -- --force

# O limpiar y empezar de nuevo
npm run clean
npm run translate:all
```

### Error: "XLF file not found"

**Causa**: El archivo `messages.xlf` no existe en el directorio.

**Solucion**:
```bash
# Verifica que el archivo existe
ls messages.xlf

# Si no existe, extraelo de tu proyecto Angular
ng extract-i18n --output-path . --out-file messages.xlf
```

### Error: "Invalid JSON" en configuracion

**Causa**: El archivo `i18n.config.json` tiene errores de sintaxis JSON.

**Solucion**:
- Valida el JSON en un linter online
- Asegurate de que todas las comas y comillas esten correctas
- Verifica que no haya comentarios (JSON no soporta comentarios)

---

## Dependencias

| Paquete | Version | Proposito |
|---------|---------|-----------|
| `@xmldom/xmldom` | ^0.8.10 | Parser XML para archivos XLF |
| `csv-parse` | ^5.5.6 | Lectura de archivos CSV |
| `csv-stringify` | ^6.5.1 | Escritura de archivos CSV |
| `dotenv` | ^16.6.1 | Carga de variables de entorno |

---

## Licencia

MIT License - Uso libre para proyectos personales y comerciales.

---

## Contribuciones

Las contribuciones son bienvenidas. Por favor, abre un issue o pull request para sugerir mejoras o reportar bugs.
