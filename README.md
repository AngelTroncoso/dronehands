# 🛸 DRONE HANDS — Prototipo IoT de control gestual con dos manos

Videojuego inmersivo controlado **con las manos y sin mandos**, usando **MediaPipe Hand Landmarker** (`num_hands = 2`) ejecutándose 100% en el navegador (WebAssembly + GPU). Sitio estático listo para desplegar en **Vercel**.

## 🎮 Controles gestuales «estilo dron»

| Mano | Gesto | Acción |
|------|-------|--------|
| ✋ **Izquierda** | Subir / bajar la **muñeca** (eje Y) | Altitud del dron (calibrada al inicio) |
| ✋ **Izquierda** | Puño cerrado | Hover (bloquea la altitud) |
| 🫱 **Derecha** | **Ángulo muñeca → punta del índice** hacia la derecha | Acelerar |
| 🫱 **Derecha** | Dedos apuntando arriba | Hover / crucero |
| 🫱 **Derecha** | Dedos apuntando a la izquierda | Retroceso |
| 🫱 **Derecha** | Girar la **palma** vertical (manillar) | Desplazamiento lateral |
| 🫱 **Derecha** | Pinza (índice + pulgar) | ⚡ TURBO · puntos x2 |

La **handedness** de MediaPipe separa ambas manos; hay una opción «Intercambiar manos L/R» por si la detección sale invertida en tu cámara. Respaldo de teclado: flechas + espacio, `P` pausa.

**Objetivo:** atravesar las puertas neón, coger los anillos dorados (+15) y los chips IoT (+5), encadenar combo x5 y sobrevivir con 3 baterías. La dificultad crece con la puntuación.

## 🚀 Probar en local

Requiere un servidor (por el módulo ES y el permiso de cámara; `file://` no vale):

```bash
npm run dev          # o: npx -y serve -l 3000 .
# abre http://localhost:3000
```

La primera vez descarga ~7 MB del modelo `hand_landmarker.task` desde el CDN de MediaPipe; después queda en caché.

## ☁️ Desplegar en Vercel

### Opción A · CLI
```bash
npm i -g vercel
vercel          # preview
vercel --prod   # producción
```

### Opción B · GitHub + Dashboard
1. Sube el proyecto a un repositorio de GitHub.
2. En [vercel.com/new](https://vercel.com/new) importa el repo.
3. Framework preset: **Other** (sitio estático; no hay build). Deploy.

Vercel sirve HTTPS automáticamente, requisito del navegador para `getUserMedia` (cámara).

## 🏗️ Arquitectura

```
index.html          UI, HUD, webcam, pantallas
css/style.css       Estética cyber-neón inmersiva
js/gestures.js      MediaPipe Hand Landmarker (2 manos) + extracción de gestos
js/world.js         Mundo: puertas, anillos, chips, partículas, parallax
js/game.js          Bucle, estados, física, audio WebAudio, teclado
vercel.json         Cabeceras y configuración estática
```

Pipeline por fotograma: `video` → `HandLandmarker.detectForVideo()` → 21 landmarks × 2 manos con **handedness** → features suavizadas (EMA) → física del dron → render canvas 2D.

🔒 **Privacidad:** todo el procesamiento es local; ningún fotograma sale del dispositivo.

## 🧰 Solución de problemas

- **«No se pudo iniciar»** → revisa permiso de cámara; exige HTTPS o `localhost`.
- **Bajo FPS** → el juego hace fallback automático GPU→CPU; cierra pestañas y usa Chrome/Edge.
- **Manos invertidas** → activa «Intercambiar manos L/R» en la pantalla inicial.
- **Latencia de gestos** → mantén las manos bien iluminadas y a 40–80 cm de la cámara.