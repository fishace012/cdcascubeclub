/* =====================================================
   交互式 3D 三阶魔方（纯原生 CSS 3D + JavaScript 实现）
   -----------------------------------------------------
   实现思路（答辩要点）：
   1. 结构：魔方由 27 个小方块（cubie）组成，每个小方块是一个
      div，内部再放 6 个面（<i> 元素），用 CSS 3D transform
      摆出正方体的六个朝向；每个面的颜色按标准配色固定。
   2. 姿态：每个小方块记录两个状态——
      p：它在魔方里的网格坐标 (x,y,z)，取值 -1/0/1；
      m：它自身的旋转矩阵（3x3 整数矩阵）。
      小方块的最终 transform = 平移(网格位置) × 旋转(姿态矩阵)，
      以 matrix3d(...) 写入 style，浏览器负责 3D 渲染。
   3. 拧动一层：一次 90° 转动 = 把某一层上的 9 个小方块
      各自的 p 和 m 左乘一个 90° 旋转矩阵（纯整数运算，
      不会累积浮点误差）。动画交给 CSS transition 在新旧
      matrix3d 之间平滑过渡。
   4. 视角旋转：所有小方块外面套一个 stage 容器，
      stage 的 transform = rotateX(rx) rotateY(ry)。
      自动旋转就是每帧给 ry 加一个很小的角度；
      拖动空白处时按拖动增量修改 rx / ry。
   5. 手势判定：按在色块上拖动 = 拧动那一层；
      按在魔方外的空白处拖动 = 旋转视角。
      拧动方向用向量叉积计算：
      旋转轴 ω = 面法向 n × 拖动方向 d（再吸附到最近坐标轴）。
   ===================================================== */
(function () {
  "use strict";

  var scene = document.getElementById("cubeScene");
  var stage = document.getElementById("cubeStage");
  if (!scene || !stage) return;

  /* ---------- 常量 ---------- */

  // 六个面的定义：CSS 类名、朝向法线（小方块自身坐标系）、贴纸颜色。
  // 注意 CSS 的 y 轴向下，所以“上面”的法线是 (0,-1,0)。
  // 配色为标准魔方配色：上白、下黄、前绿、后蓝、右红、左橙。
  var FACES = [
    { cls: "f-r", n: [1, 0, 0] },   // 右：红
    { cls: "f-l", n: [-1, 0, 0] },  // 左：橙
    { cls: "f-u", n: [0, -1, 0] },  // 上：白
    { cls: "f-d", n: [0, 1, 0] },   // 下：黄
    { cls: "f-f", n: [0, 0, 1] },   // 前：绿
    { cls: "f-b", n: [0, 0, -1] }   // 后：蓝
  ];
  var AXIS_INDEX = { x: 0, y: 1, z: 2 };

  /* ---------- 小工具函数 ---------- */

  // 矩阵 × 向量
  function matVec(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
    ];
  }
  // 矩阵 × 矩阵（行主序 3x3）
  function matMul(a, b) {
    var r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++)
        r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    return r;
  }
  // 叉积
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  // 绕 x / y 轴旋转任意角度的矩阵（仅用于方向换算，允许浮点）
  function rotXm(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [[1, 0, 0], [0, c, -s], [0, s, c]];
  }
  function rotYm(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  }
  // 绕某坐标轴转 90° 的整数矩阵（dir = +1 或 -1），用于真实转动魔方
  function rot90(axis, dir) {
    var s = dir;
    if (axis === "x") return [[1, 0, 0], [0, 0, -s], [0, s, 0]];
    if (axis === "y") return [[0, 0, s], [0, 1, 0], [-s, 0, 0]];
    return [[0, -s, 0], [s, 0, 0], [0, 0, 1]];
  }

  /* ---------- 状态 ---------- */

  var cubies = [];          // 全部 27 个小方块：{ el, p:[x,y,z], m:3x3 }
  var cs = 56;              // 小方块边长（px），随窗口尺寸调整
  var rxDeg = -24;          // 舞台俯仰角（初始稍俯视，能看到顶面）
  var ryDeg = -32;          // 舞台水平角（初始稍侧转，能看到右面）
  var AUTO_SPEED = 0.12;    // 自动旋转：每帧增加的角度（度）
  var IDLE_MS = 2600;       // 用户操作后暂停自转的时长（毫秒）
  var lastInteract = 0;     // 上次用户交互时间
  var drag = null;          // 当前手势：null 或 {mode, ...}
  var turning = false;      // 是否正在播放单层转动动画
  var queue = [];           // 待执行的转动请求队列
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 构建 27 个小方块 ---------- */

  function build() {
    stage.innerHTML = "";
    cubies = [];
    for (var x = -1; x <= 1; x++)
      for (var y = -1; y <= 1; y++)
        for (var z = -1; z <= 1; z++) {
          var el = document.createElement("div");
          el.className = "cubie";
          for (var k = 0; k < FACES.length; k++) {
            var f = FACES[k];
            var face = document.createElement("i");
            face.className = f.cls;
            // 记录该面朝向，供手势判定读取
            face.dataset.nx = f.n[0];
            face.dataset.ny = f.n[1];
            face.dataset.nz = f.n[2];
            // 小方块位于外表面时，对应的面贴彩色贴纸
            if (x * f.n[0] + y * f.n[1] + z * f.n[2] === 1) {
              face.classList.add("out");
            }
            el.appendChild(face);
          }
          stage.appendChild(el);
          cubies.push({
            el: el,
            p: [x, y, z],                            // 网格坐标
            m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]     // 初始姿态：单位矩阵
          });
        }
  }

  /* ---------- 渲染 ---------- */

  // 把一个小方块的 (位置 p, 姿态 m) 写成 matrix3d。
  // matrix3d 是列主序：前 3 列是旋转矩阵的 3 个列向量，第 4 列是平移。
  function render(c) {
    var t = [c.p[0] * cs, c.p[1] * cs, c.p[2] * cs]; // 网格坐标 → 像素位移
    var m = c.m;
    var v = [
      m[0][0], m[1][0], m[2][0], 0,
      m[0][1], m[1][1], m[2][1], 0,
      m[0][2], m[1][2], m[2][2], 0,
      t[0], t[1], t[2], 1
    ];
    c.el.style.transform = "matrix3d(" + v.join(",") + ")";
  }

  // 根据容器宽度计算小方块边长（窗口变化时调用）
  function layout() {
    var w = scene.clientWidth;
    if (w < 60) return;
    cs = Math.round(w / 3.8); // 3 个方块 + 一点余量，留出拖动空间
    stage.style.setProperty("--cs", cs + "px");
    for (var i = 0; i < cubies.length; i++) render(cubies[i]);
  }

  /* ---------- 单层转动 ---------- */

  function requestTurn(axis, dir, layer) {
    queue.push({ axis: axis, dir: dir, layer: layer });
    processQueue();
  }

  function processQueue() {
    if (turning || queue.length === 0) return;
    turning = true;

    var req = queue.shift();
    var R = rot90(req.axis, req.dir);
    var ai = AXIS_INDEX[req.axis];

    // 找出该层上的 9 个小方块，更新它们的网格坐标与姿态矩阵
    var affected = [];
    for (var i = 0; i < cubies.length; i++) {
      if (cubies[i].p[ai] === req.layer) affected.push(cubies[i]);
    }
    for (var j = 0; j < affected.length; j++) {
      affected[j].p = matVec(R, affected[j].p);
      affected[j].m = matMul(R, affected[j].m);
    }

    // 用 CSS transition 播放平滑转动动画：
    // 先开过渡 → 强制回流 → 再写入新 transform
    for (var k = 0; k < affected.length; k++) {
      affected[k].el.style.transition = "transform .3s cubic-bezier(.25,.7,.3,1)";
    }
    void stage.offsetWidth;
    for (var k2 = 0; k2 < affected.length; k2++) render(affected[k2]);

    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      for (var i = 0; i < affected.length; i++) {
        affected[i].el.style.transition = "";
      }
      turning = false;
      processQueue(); // 处理排队中的下一次转动
    }
    // transitionend 加 setTimeout 兜底，避免某些浏览器不触发事件
    affected[0].el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 340);
  }

  /* ---------- 手势判定 ---------- */

  // 根据“点击的面 + 拖动方向”计算要拧哪一层、往哪个方向拧。
  // 原理：在该面上拖动相当于让层绕轴 ω = n × d 旋转（n 面法向、d 拖动方向）。
  function computeTurn(dragState, dx, dy) {
    // 1) 被点击面的外法向（先从小方块自身坐标系转回魔方坐标系）
    var nLocal = [+dragState.face.dataset.nx, +dragState.face.dataset.ny, +dragState.face.dataset.nz];
    var nCube = matVec(dragState.cubie.m, nLocal);
    // 2) 屏幕拖动方向 → 相机空间 (dx, dy, 0)（CSS 的 y 轴向下，与屏幕一致）
    //    再逆变换回舞台坐标系：stage transform = rotateX(rx) rotateY(ry)
    var rx = rxDeg * Math.PI / 180, ry = ryDeg * Math.PI / 180;
    var dStage = matVec(rotYm(-ry), matVec(rotXm(-rx), [dx, dy, 0]));
    // 3) 旋转轴 = 法向 × 拖动方向，吸附到最近的坐标轴
    var w = cross(nCube, dStage);
    var abs = [Math.abs(w[0]), Math.abs(w[1]), Math.abs(w[2])];
    var maxAbs = Math.max(abs[0], abs[1], abs[2]);
    if (maxAbs < 0.15) return null; // 拖动方向不明确，忽略
    var axis = abs[0] >= abs[1] && abs[0] >= abs[2] ? "x" :
               abs[1] >= abs[2] ? "y" : "z";
    var dir = w[AXIS_INDEX[axis]] > 0 ? 1 : -1;
    // 4) 被点击的小方块在该轴上的坐标 = 要转动的层号（-1 / 0 / 1）
    return { axis: axis, dir: dir, layer: dragState.cubie.p[AXIS_INDEX[axis]] };
  }

  /* ---------- 指针事件（鼠标 + 触屏统一处理） ---------- */

  // 交互区域扩大到整个主视觉区：在色块上拖 = 拧层，
  // 在空白处拖 = 旋转视角（场景外围的空白也能响应）
  var zone = scene.parentElement || scene;

  zone.addEventListener("pointerdown", function (e) {
    if (drag) return;
    var face = e.target.closest ? e.target.closest(".cubie i") : null;
    var cubieEl = e.target.closest ? e.target.closest(".cubie") : null;
    drag = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      mode: "orbit" // 默认：拖空白处 = 旋转视角
    };
    if (face && cubieEl && !turning) {
      for (var i = 0; i < cubies.length; i++) {
        if (cubies[i].el === cubieEl) { drag.cubie = cubies[i]; break; }
      }
      if (drag.cubie) {
        drag.face = face;      // 记录被点击的面，供拧动方向计算使用
        drag.mode = "face";    // 按在色块上 = 拧动一层
      }
    }
    try { zone.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    lastInteract = performance.now();
  });

  zone.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.sx;
    var dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 10) return; // 消抖死区

    if (drag.mode === "orbit") {
      // 视角旋转：增量式修改舞台角度
      drag.moved = true;
      ryDeg += dx * 0.4;
      rxDeg = Math.max(-85, Math.min(85, rxDeg - dy * 0.4));
      drag.sx = e.clientX;
      drag.sy = e.clientY;
      lastInteract = performance.now();
    } else if (drag.mode === "face") {
      // 拧动一层：方向一旦明确就执行一次 90° 转动
      drag.moved = true;
      var t = computeTurn(drag, dx, dy);
      if (t) {
        drag.mode = "done"; // 一次手势只拧一层
        requestTurn(t.axis, t.dir, t.layer);
      }
      lastInteract = performance.now();
    }
  });

  function endDrag(e) {
    if (drag && e.pointerId === drag.id) drag = null;
  }
  zone.addEventListener("pointerup", endDrag);
  zone.addEventListener("pointercancel", endDrag);
  // 手机长按不弹右键菜单
  zone.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  /* ---------- 自动旋转 ---------- */

  function frame(now) {
    if (!document.hidden) {
      // 用户正在操作或刚操作完 → 暂停自转；空闲后恢复
      var idle = now - lastInteract > IDLE_MS;
      if (!drag && !turning && !reduceMotion && idle) {
        ryDeg += AUTO_SPEED;
      }
      stage.style.transform = "rotateX(" + rxDeg + "deg) rotateY(" + ryDeg + "deg)";
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 启动 ---------- */

  build();
  layout();
  window.addEventListener("resize", layout);
  requestAnimationFrame(frame);
})();
