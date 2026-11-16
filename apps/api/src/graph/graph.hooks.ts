/**
 * 图谱维护钩子（解耦容器）。
 *
 * 存在理由：正文索引（ArchivesModule）需要在「附件正文索引完成」后通知图谱刷新，
 * 而图谱模块又必须依赖 ArchivesModule 才能读取档案与正文——直接互相注入会形成
 * Nest 循环依赖。这里用一个全局可注入的「委托持有者」把方向拆成：
 *   ArchivesModule → GraphMaintenanceHooks ← GraphModule（构建完成后注册委托）。
 * 图谱未启用（或尚未注册委托）时全部方法都是空操作，业务写入完全不受影响；
 * 所有委托调用都在 try/catch 内执行：图谱刷新失败绝不阻断上传 / 索引 / 归档业务。
 */
import { Injectable } from '@nestjs/common';

/** 图谱侧需要实现的维护动作（与 GraphBuildService 的公开方法一一对应）。 */
export interface GraphMaintenanceDelegate {
  /** 附件正文索引发生变化后刷新所属档案的图谱（含该档案的知识块节点与关联）。 */
  refreshArchive(archiveId: number): void;
  /** 单个附件正文发生变化后的刷新（服务层只有 fileId 时用，内部解析所属档案）。 */
  refreshFile(fileId: number): void;
  /** 档案被删除后清理其节点与关系（数据库触发器已兜底，此处为显式清理入口）。 */
  removeArchive(archiveId: number): void;
}

export const GRAPH_MAINTENANCE_HOOKS = 'GRAPH_MAINTENANCE_HOOKS';

@Injectable()
export class GraphMaintenanceHooks {
  private delegate?: GraphMaintenanceDelegate;

  /** 图谱模块初始化时注册自身；重复注册以最后一次为准（单实例场景只有一次）。 */
  register(delegate: GraphMaintenanceDelegate | undefined): void {
    this.delegate = delegate;
  }

  enabled(): boolean {
    return !!this.delegate;
  }

  /** 尽力而为的刷新：任何异常只记 warn，不向上冒泡影响调用方业务事务。 */
  refreshArchiveSafely(archiveId: number, scene: string): boolean {
    if (!this.delegate) return false;
    try {
      this.delegate.refreshArchive(archiveId);
      return true;
    } catch (err) {
      console.warn(`[graph] ${scene} 图谱刷新失败（不影响业务）：${(err as Error)?.message ?? err}`);
      return false;
    }
  }

  /** 附件级的尽力刷新（索引完成后调用，只入去抖队列，不拖慢上传链路）。 */
  refreshFileSafely(fileId: number, scene: string): boolean {
    if (!this.delegate) return false;
    try {
      this.delegate.refreshFile(fileId);
      return true;
    } catch (err) {
      console.warn(`[graph] ${scene} 图谱刷新失败（不影响业务）：${(err as Error)?.message ?? err}`);
      return false;
    }
  }

  removeArchiveSafely(archiveId: number, scene: string): boolean {
    if (!this.delegate) return false;
    try {
      this.delegate.removeArchive(archiveId);
      return true;
    } catch (err) {
      console.warn(`[graph] ${scene} 图谱清理失败（不影响业务）：${(err as Error)?.message ?? err}`);
      return false;
    }
  }
}
