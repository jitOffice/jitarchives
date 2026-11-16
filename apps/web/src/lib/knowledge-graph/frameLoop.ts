/**
 * 档案知识图谱 · 画布重绘调度（纯函数，不依赖 Vue / DOM，可单独测试）。
 *
 * 只做一件事：把同一帧内的多次重绘请求合并成一次 requestAnimationFrame，
 * 绘制完成后立即结束——不会自我续期，因此不存在「持续申请 RAF」的动画循环。
 * 组件卸载时 cancel 掉尚未执行的那一帧，不留残余任务。
 *
 * 调度端口可注入（单测用假端口驱动），默认走浏览器 requestAnimationFrame。
 */

export interface FramePort {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface FrameLoopStats {
  /** 实际执行的绘制帧数。 */
  frames: number;
  /** 收到的重绘请求数（含被合并掉的）。 */
  requests: number;
  /** 是否还有已排期未执行的重绘帧。 */
  pending: boolean;
}

export interface FrameLoop {
  /** 请求一次重绘：同一帧内重复调用只会排一次。 */
  request(): void;
  /** 取消已排期的重绘（卸载时调用），不会再回调。 */
  cancel(): void;
  stats(): FrameLoopStats;
}

function defaultPort(): FramePort {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    };
  }
  // 非浏览器环境（Node 单测 / SSR）：不排期，避免产生悬挂任务
  return { request: () => 0, cancel: () => {} };
}

export function createFrameLoop(draw: (time: number) => void, port: FramePort = defaultPort()): FrameLoop {
  let handle = 0;
  let frames = 0;
  let requests = 0;

  const tick = (time: number): void => {
    handle = 0;
    frames += 1;
    draw(time);
    // 刻意不在这里继续 request：一次请求只换一帧，绘制完即结束
  };

  return {
    request(): void {
      requests += 1;
      if (handle) return; // 已排期：合并到同一帧
      handle = port.request(tick);
    },
    cancel(): void {
      if (!handle) return;
      port.cancel(handle);
      handle = 0;
    },
    stats: () => ({ frames, requests, pending: handle !== 0 }),
  };
}
