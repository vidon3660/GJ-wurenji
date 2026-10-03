(() => {
  "use strict";

  const TOTAL_SECONDS = 144;
  const center = { lon: 113.9485, lat: 22.5389 };
  const colors = ["#168461", "#3879c9", "#d78b20", "#7a6ab0", "#cf5b56", "#3a8d9c"];
  const droneNames = ["无人机 01", "无人机 02", "无人机 03", "无人机 04", "无人机 05", "无人机 06"];
  const layerEntities = {};
  const droneEntities = [];
  const dronePositions = [];
  const addedWaypoints = [];
  let viewer;
  let activeTool = "select";
  let activeMode = "design";
  let currentSeconds = 0;
  let speedIndex = 0;
  let playing = false;
  let animationFrame;
  let lastFrameTime;
  let is2D = false;

  const speeds = [1, 2, 4, 0.5];
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function createIcons() {
    if (window.lucide) {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }
  }

  function renderFallbackMap() {
    const root = qs("#osmFallback");
    const stage = qs(".map-stage");
    if (!root || !stage) return;

    const zoom = 16;
    const tileSize = 256;
    const radius = 2;
    const scale = 2 ** zoom;
    const x = ((center.lon + 180) / 360) * scale;
    const latitudeRadians = center.lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2 * scale;
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    const startX = tileX - radius;
    const startY = tileY - radius;
    const left = stage.clientWidth / 2 - (radius + (x - tileX)) * tileSize;
    const top = stage.clientHeight / 2 - (radius + (y - tileY)) * tileSize;

    root.innerHTML = "";
    for (let row = 0; row <= radius * 2; row += 1) {
      for (let column = 0; column <= radius * 2; column += 1) {
        const image = document.createElement("img");
        image.alt = "";
        image.decoding = "async";
        image.loading = "eager";
        image.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${startY + row}/${startX + column}`;
        image.style.left = `${left + column * tileSize}px`;
        image.style.top = `${top + row * tileSize}px`;
        root.appendChild(image);
      }
    }
  }

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i data-lucide="${type === "error" ? "circle-alert" : "circle-check"}"></i><span>${message}</span>`;
    qs("#toastStack").appendChild(toast);
    createIcons();
    window.setTimeout(() => toast.remove(), 3200);
  }

  function formatTime(value) {
    const seconds = Math.max(0, Math.min(TOTAL_SECONDS, Math.round(value)));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateTimeline(value) {
    currentSeconds = Math.max(0, Math.min(TOTAL_SECONDS, value));
    qs("#timelineRange").value = String(currentSeconds);
    qs("#currentTime").textContent = formatTime(currentSeconds);
    qs("#timelineProgress").style.width = `${(currentSeconds / TOTAL_SECONDS) * 100}%`;
    updateDronePositions(currentSeconds / TOTAL_SECONDS);
  }

  function setPlaying(nextPlaying) {
    playing = nextPlaying;
    const iconName = playing ? "pause" : "play";
    qs("#playButton").innerHTML = `<i data-lucide="${iconName}"></i>`;
    qs("#playButton").setAttribute("aria-label", playing ? "暂停仿真" : "播放仿真");
    createIcons();

    if (playing) {
      if (currentSeconds >= TOTAL_SECONDS) updateTimeline(0);
      activeMode = "simulate";
      setModeButton("simulate");
      lastFrameTime = performance.now();
      animationFrame = requestAnimationFrame(runPlayback);
    } else if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }
  }

  function runPlayback(now) {
    if (!playing) return;
    const delta = ((now - lastFrameTime) / 1000) * speeds[speedIndex];
    lastFrameTime = now;
    updateTimeline(currentSeconds + delta);
    if (currentSeconds >= TOTAL_SECONDS) {
      setPlaying(false);
      showToast("仿真回放已完成，发现 2 个待修正风险", "error");
      return;
    }
    animationFrame = requestAnimationFrame(runPlayback);
  }

  function routePoint(routeIndex, progress) {
    const offset = (routeIndex - 2.5) * 0.00018;
    const points = [
      [center.lon - 0.0025 + offset, center.lat - 0.0017],
      [center.lon - 0.0015 + offset * 0.6, center.lat - 0.00055],
      [center.lon - 0.0005 + offset * 0.25, center.lat + 0.0013],
      [center.lon + 0.0015 + offset * 0.35, center.lat + 0.00085],
      [center.lon + 0.00245 + offset, center.lat - 0.00155]
    ];
    const scaled = progress * (points.length - 1);
    const segment = Math.min(points.length - 2, Math.floor(scaled));
    const local = Math.min(1, scaled - segment);
    const from = points[segment];
    const to = points[segment + 1];
    return [
      from[0] + (to[0] - from[0]) * local,
      from[1] + (to[1] - from[1]) * local,
      80 + Math.sin(progress * Math.PI) * 15
    ];
  }

  function updateDronePositions(progress) {
    if (!viewer || !window.Cesium) return;
    droneEntities.forEach((entity, index) => {
      const pos = routePoint(index, Math.max(0, Math.min(1, progress - index * 0.008)));
      entity.position = Cesium.Cartesian3.fromDegrees(...pos);
      dronePositions[index] = pos;
    });
    viewer.scene.requestRender();
  }

  function positionsForRoute(index) {
    return [0, 0.25, 0.5, 0.75, 1].map((progress) => routePoint(index, progress));
  }

  function addSceneEntities() {
    const boundaryPositions = [
      center.lon - 0.0032, center.lat - 0.0023,
      center.lon + 0.0032, center.lat - 0.0023,
      center.lon + 0.0032, center.lat + 0.0022,
      center.lon - 0.0032, center.lat + 0.0022
    ];
    layerEntities.boundary = viewer.entities.add({
      name: "安全边界",
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(boundaryPositions),
        material: Cesium.Color.fromCssColorString("#168461").withAlpha(0.08),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#168461"),
        height: 0
      }
    });

    const noFlyPositions = [
      center.lon - 0.00025, center.lat + 0.00015,
      center.lon + 0.00125, center.lat + 0.00025,
      center.lon + 0.00115, center.lat + 0.00135,
      center.lon - 0.00045, center.lat + 0.0012
    ];
    layerEntities.noFly = viewer.entities.add({
      name: "临时禁飞区",
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(noFlyPositions),
        material: Cesium.Color.fromCssColorString("#d24b45").withAlpha(0.3),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#d24b45"),
        height: 8,
        extrudedHeight: 120
      }
    });

    layerEntities.building = viewer.entities.add({
      name: "教学楼障碍物",
      position: Cesium.Cartesian3.fromDegrees(center.lon - 0.00115, center.lat + 0.00055, 18),
      box: {
        dimensions: new Cesium.Cartesian3(65, 45, 36),
        material: Cesium.Color.fromCssColorString("#6b746f").withAlpha(0.82),
        outline: true,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.8)
      }
    });

    layerEntities.landing = viewer.entities.add({
      name: "起降区 A",
      position: Cesium.Cartesian3.fromDegrees(center.lon - 0.00245, center.lat - 0.0017, 1),
      ellipse: {
        semiMajorAxis: 32,
        semiMinorAxis: 32,
        material: Cesium.Color.fromCssColorString("#168461").withAlpha(0.35),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#e9fff6")
      },
      label: {
        text: "起降区 A",
        font: "12px sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#202522").withAlpha(0.82),
        pixelOffset: new Cesium.Cartesian2(0, -34)
      }
    });

    layerEntities.routes = [];
    droneNames.forEach((name, index) => {
      const routePositions = positionsForRoute(index);
      const line = viewer.entities.add({
        name: `${name} 航线`,
        polyline: {
          positions: routePositions.map((p) => Cesium.Cartesian3.fromDegrees(...p)),
          width: index === 2 ? 4 : 2,
          material: Cesium.Color.fromCssColorString(colors[index]).withAlpha(index === 2 ? 0.95 : 0.65),
          clampToGround: false
        }
      });
      layerEntities.routes.push(line);

      const initial = routePoint(index, 0);
      const drone = viewer.entities.add({
        name,
        position: Cesium.Cartesian3.fromDegrees(...initial),
        point: {
          pixelSize: index === 2 ? 13 : 10,
          color: Cesium.Color.fromCssColorString(colors[index]),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: String(index + 1).padStart(2, "0"),
          font: "10px sans-serif",
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#202522").withAlpha(0.78),
          pixelOffset: new Cesium.Cartesian2(0, -22),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000)
        }
      });
      droneEntities.push(drone);
    });

    layerEntities.riskNoFly = viewer.entities.add({
      name: "风险：进入禁飞区",
      position: Cesium.Cartesian3.fromDegrees(center.lon + 0.00035, center.lat + 0.0008, 102),
      point: {
        pixelSize: 17,
        color: Cesium.Color.fromCssColorString("#d24b45"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: "!",
        font: "bold 13px sans-serif",
        fillColor: Cesium.Color.WHITE,
        pixelOffset: new Cesium.Cartesian2(0, 4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });

    layerEntities.riskSeparation = viewer.entities.add({
      name: "风险：间距不足",
      position: Cesium.Cartesian3.fromDegrees(center.lon + 0.00125, center.lat + 0.00065, 86),
      point: {
        pixelSize: 15,
        color: Cesium.Color.fromCssColorString("#c47910"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  function flyHome() {
    if (!viewer) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat - 0.005, 1250),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-58),
        roll: 0
      },
      duration: 0.8
    });
  }

  function flyToKey(key) {
    if (!viewer) return;
    const targets = {
      boundary: [center.lon, center.lat, 850],
      noFly: [center.lon + 0.00045, center.lat + 0.0008, 420],
      building: [center.lon - 0.00115, center.lat + 0.00055, 260],
      landing: [center.lon - 0.00245, center.lat - 0.0017, 240],
      separation: [center.lon + 0.00125, center.lat + 0.00065, 280]
    };
    const target = targets[key] || targets.boundary;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(...target),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
      duration: 0.65
    });
  }

  function addWaypointAt(position) {
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    const lon = Cesium.Math.toDegrees(cartographic.longitude);
    const lat = Cesium.Math.toDegrees(cartographic.latitude);
    const index = addedWaypoints.length + 5;
    const entity = viewer.entities.add({
      name: `WP-03-${String(index - 2).padStart(2, "0")}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, Number(qs("#altitudeInput").value)),
      point: {
        pixelSize: 11,
        color: Cesium.Color.fromCssColorString("#168461"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    addedWaypoints.push(entity);

    const button = document.createElement("button");
    button.className = "waypoint-item selected";
    button.innerHTML = `<span class="waypoint-index">${String(index).padStart(2, "0")}</span><span><strong>WP-03-${String(index - 2).padStart(2, "0")}</strong><small>高度 ${qs("#altitudeInput").value} m · 新增航点</small></span><i data-lucide="grip-vertical"></i>`;
    qsa(".waypoint-item", qs("#waypointList")).forEach((item) => item.classList.remove("selected"));
    qs("#waypointList").appendChild(button);
    createIcons();
    showToast(`已添加航点 WP-03-${String(index - 2).padStart(2, "0")}`);
  }

  function initCesium() {
    const loading = qs("#mapLoading");
    if (!window.Cesium) {
      loading.innerHTML = "<strong>地图组件加载失败</strong><span>请检查网络连接后刷新页面</span>";
      return;
    }

    try {
      const osmProvider = new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Tiles © Esri"
      });
      viewer = new Cesium.Viewer("cesiumContainer", {
        animation: false,
        baseLayer: new Cesium.ImageryLayer(osmProvider),
        baseLayerPicker: false,
        contextOptions: {
          webgl: {
            alpha: true
          }
        },
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false
      });
      window.__prototypeViewer = viewer;
      viewer.scene.globe.depthTestAgainstTerrain = false;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#dfe7e2");
      viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
      viewer.scene.skyBox.show = false;
      viewer.scene.skyAtmosphere.show = false;
      viewer.scene.sun.show = false;
      viewer.scene.moon.show = false;
      viewer.scene.screenSpaceCameraController.minimumZoomDistance = 70;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = 12000;

      addSceneEntities();
      flyHome();
      updateTimeline(0);

      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (activeTool !== "waypoint") return;
        const ray = viewer.camera.getPickRay(click.position);
        const position = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
        if (position) addWaypointAt(position);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      window.setTimeout(() => loading.classList.add("is-hidden"), 700);
    } catch (error) {
      console.error(error);
      loading.innerHTML = "<strong>三维地图初始化失败</strong><span>界面其他功能仍可预览</span>";
    }
  }

  function renderDroneList() {
    const root = qs("#droneList");
    root.innerHTML = droneNames.map((name, index) => `
      <button class="tree-row ${index === 2 ? "selected has-risk" : ""}" data-drone="${index}">
        <span class="drone-symbol" style="--drone-color:${colors[index]}">${String(index + 1).padStart(2, "0")}</span>
        <span class="drone-meta"><span>${name}</span>${index === 2 || index === 4 ? '<i class="risk-mini" data-lucide="triangle-alert"></i>' : ""}</span>
        <span class="visibility on"><i data-lucide="eye"></i></span>
      </button>
    `).join("");
  }

  function setModeButton(mode) {
    activeMode = mode;
    qsa(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    if (mode === "review") switchRightTab("risks");
    if (mode === "simulate" && !playing) showToast("已切换到仿真模式，可使用底部时间轴回放");
  }

  function switchRightTab(tab) {
    qsa("[data-right-tab]").forEach((button) => button.classList.toggle("active", button.dataset.rightTab === tab));
    qs("#propertiesPanel").classList.toggle("hidden", tab !== "properties");
    qs("#risksPanel").classList.toggle("hidden", tab !== "risks");
  }

  function switchLeftTab(tab) {
    qsa("[data-left-tab]").forEach((button) => button.classList.toggle("active", button.dataset.leftTab === tab));
    qs("#objectsPanel").classList.toggle("hidden", tab !== "objects");
    qs("#versionsPanel").classList.toggle("hidden", tab !== "versions");
  }

  function setTool(tool) {
    activeTool = tool;
    qsa("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    qs("#drawHint").classList.toggle("hidden", tool !== "waypoint");
    if (viewer) viewer.container.style.cursor = tool === "waypoint" ? "crosshair" : "default";
  }

  function selectDrone(index) {
    qsa("[data-drone]").forEach((row) => row.classList.toggle("selected", Number(row.dataset.drone) === index));
    qs("#selectedDroneName").textContent = `${droneNames[index]} · 航线`;
    qs("#routeName").value = index === 2 ? "东侧巡查航线" : `规划航线 ${String(index + 1).padStart(2, "0")}`;
    if (viewer && droneEntities[index]) viewer.flyTo(droneEntities[index], { duration: 0.55, offset: new Cesium.HeadingPitchRange(0, -0.9, 420) });
  }

  function closeMobilePanels() {
    qs("#leftPanel").classList.remove("is-open");
    qs("#rightPanel").classList.remove("is-open");
    qs("#mobileScrim").classList.remove("is-visible");
  }

  function openMobilePanel(id) {
    closeMobilePanels();
    qs(id).classList.add("is-open");
    qs("#mobileScrim").classList.add("is-visible");
  }

  function bindUI() {
    qsa("[data-left-tab]").forEach((button) => button.addEventListener("click", () => switchLeftTab(button.dataset.leftTab)));
    qsa("[data-right-tab]").forEach((button) => button.addEventListener("click", () => switchRightTab(button.dataset.rightTab)));
    qsa("[data-mode]").forEach((button) => button.addEventListener("click", () => setModeButton(button.dataset.mode)));
    qsa("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));

    qs("#playButton").addEventListener("click", () => setPlaying(!playing));
    qs("#stopButton").addEventListener("click", () => { setPlaying(false); updateTimeline(0); setModeButton("design"); });
    qs("#timelineRange").addEventListener("input", (event) => updateTimeline(Number(event.target.value)));
    qs("#speedButton").addEventListener("click", () => {
      speedIndex = (speedIndex + 1) % speeds.length;
      qs("#speedButton").textContent = `${speeds[speedIndex].toFixed(1)}x`;
    });

    qs("#spacingRange").addEventListener("input", (event) => { qs("#spacingOutput").textContent = `${event.target.value} m`; });
    qs("#validateButton").addEventListener("click", () => { switchRightTab("risks"); setModeButton("review"); showToast("校验完成：5 项规则中 4 项通过，发现 2 个风险", "error"); });
    qs("#submitButton").addEventListener("click", () => showToast("当前仍有严重风险，修正后才能提交", "error"));
    qs("#historyButton").addEventListener("click", () => switchLeftTab("versions"));
    qs("#showRequirements").addEventListener("click", () => showToast("任务要求：完成 6 架无人机规划，并通过全部安全规则"));
    qs("#addWaypointButton").addEventListener("click", () => setTool("waypoint"));

    qs("#homeView").addEventListener("click", flyHome);
    qs("#zoomIn").addEventListener("click", () => viewer && viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.25));
    qs("#zoomOut").addEventListener("click", () => viewer && viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.3));
    qs("#toggle2D").addEventListener("click", () => {
      if (!viewer) return;
      is2D = !is2D;
      qs("#toggle2D .view-label").textContent = is2D ? "2D" : "3D";
      if (is2D) viewer.scene.morphTo2D(0.8); else viewer.scene.morphTo3D(0.8);
    });

    qs("#undoButton").addEventListener("click", () => {
      const entity = addedWaypoints.pop();
      if (!entity || !viewer) return showToast("暂无可撤销操作", "error");
      viewer.entities.remove(entity);
      const items = qsa(".waypoint-item", qs("#waypointList"));
      if (items.length > 4) items.at(-1).remove();
      showToast("已撤销最近添加的航点");
    });
    qs("#redoButton").addEventListener("click", () => showToast("暂无可重做操作", "error"));

    qsa("[data-focus]").forEach((row) => row.addEventListener("click", (event) => {
      if (event.target.closest(".visibility")) return;
      flyToKey(row.dataset.focus);
    }));
    qsa("[data-layer]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = button.dataset.layer;
      if (!layerEntities[key]) return;
      layerEntities[key].show = !layerEntities[key].show;
      button.classList.toggle("on", layerEntities[key].show);
      button.innerHTML = `<i data-lucide="${layerEntities[key].show ? "eye" : "eye-off"}"></i>`;
      createIcons();
    }));
    qsa("[data-risk]").forEach((card) => card.addEventListener("click", () => {
      const key = card.dataset.risk;
      updateTimeline(key === "noFly" ? 42 : 76);
      flyToKey(key);
    }));

    qs("#droneList").addEventListener("click", (event) => {
      const row = event.target.closest("[data-drone]");
      if (row) selectDrone(Number(row.dataset.drone));
    });
    qs("#locateSelected").addEventListener("click", () => selectDrone(2));
    qsa(".waypoint-item").forEach((item) => item.addEventListener("click", () => {
      qsa(".waypoint-item").forEach((row) => row.classList.remove("selected"));
      item.classList.add("selected");
    }));

    qs("#openLeft").addEventListener("click", () => openMobilePanel("#leftPanel"));
    qs("#openRight").addEventListener("click", () => openMobilePanel("#rightPanel"));
    qs("#mobileScrim").addEventListener("click", closeMobilePanels);
    qsa("[data-close-panel]").forEach((button) => button.addEventListener("click", closeMobilePanels));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setTool("select");
      if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        setPlaying(!playing);
      }
    });

    let resizeTimer;
    window.addEventListener("resize", () => {
      if (viewer) viewer.resize();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderFallbackMap, 120);
    });
  }

  renderDroneList();
  createIcons();
  bindUI();
  renderFallbackMap();
  initCesium();
})();
