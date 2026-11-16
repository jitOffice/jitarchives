/**
 * 借阅申请与审核接口（阶段二第四批）。
 * 全部经 SessionGuard + PermissionGuard：申请/查本人 = borrowRequest，审核 = borrowReview。
 * 申请人无法自助改状态（服务层复核）；重复/并发审批由服务端条件更新拦截。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, PermissionGuard, CurrentUser, Perm } from '../auth/guards';
import { UserView } from '../common/roles';
import { BorrowingService, BorrowRequestView } from './borrowing.service';
import { BorrowCatalogItem } from '../archives/archive.repositories';

@UseGuards(SessionGuard, PermissionGuard)
@Controller('borrow-requests')
export class BorrowingController {
  constructor(private readonly service: BorrowingService) {}

  /** 借阅目录：可发现并申请借阅的受限档案（仅目录级字段）。 */
  @Get('catalog')
  @Perm('borrowRequest')
  catalog(@CurrentUser() user: UserView): BorrowCatalogItem[] {
    return this.service.borrowableCatalog(user);
  }

  /** 我的借阅记录。 */
  @Get('mine')
  @Perm('borrowRequest')
  mine(@CurrentUser() user: UserView): BorrowRequestView[] {
    return this.service.listMine(user);
  }

  /** 审核列表：pending=待处理，processed=已处理（仅审核角色）。 */
  @Get()
  @Perm('borrowReview')
  reviewList(@Query('status') status?: string): BorrowRequestView[] {
    const s = status === 'pending' ? 'pending' : status === 'processed' ? 'processed' : '';
    return this.service.listForReview(s);
  }

  @Post()
  @Perm('borrowRequest')
  create(
    @Body() body: { archiveId?: number; purpose?: string; days?: number },
    @CurrentUser() user: UserView,
  ): BorrowRequestView {
    return this.service.createRequest(body, user);
  }

  @Post(':id/approve')
  @Perm('borrowReview')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note?: string },
    @CurrentUser() user: UserView,
  ): BorrowRequestView {
    return this.service.approve(id, user, this.note(body));
  }

  @Post(':id/reject')
  @Perm('borrowReview')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note?: string },
    @CurrentUser() user: UserView,
  ): BorrowRequestView {
    const note = this.note(body);
    if (!note) throw new BadRequestException('拒绝申请必须填写审核意见');
    return this.service.reject(id, user, note);
  }

  @Post(':id/return')
  @Perm('borrowRequest')
  returnBorrow(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserView): BorrowRequestView {
    return this.service.returnBorrow(id, user);
  }

  private note(body: { note?: string }): string {
    const n = String(body?.note ?? '').trim();
    if (n.length > 500) throw new BadRequestException('审核意见不能超过 500 个字符');
    return n;
  }
}
