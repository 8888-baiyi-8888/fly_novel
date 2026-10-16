"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOOK_TYPES = void 0;
exports.canTransitionHookStatus = canTransitionHookStatus;
/** 类型词表常量：Settler 产出的 open.type 须落在此内（§10.4 准入与六步校验①共用）。 */
exports.HOOK_TYPES = ['物件', '身份', '信息差', '承诺', '威胁', '秘密', '关系', '能力', '事件'];
/**
 * 伏笔状态迁移合法性（章节级文档 §11.2 六步校验第 ⑥ 条的模型化）：
 * 主链只能沿 open → progressing → resolved 前进；deferred 为挂起旁支，
 * 可恢复回 open/progressing；resolved 为终态。挂起状态不可直接回收，须先恢复。
 */
function canTransitionHookStatus(from, to) {
    switch (from) {
        case 'open':
            return to === 'progressing' || to === 'resolved' || to === 'deferred';
        case 'progressing':
            return to === 'resolved' || to === 'deferred';
        case 'deferred':
            return to === 'open' || to === 'progressing';
        case 'resolved':
            return false;
    }
}
//# sourceMappingURL=hook.js.map