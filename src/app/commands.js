// @ts-check
/**
 * 커맨드 생성 함수(D-08). Step 3의 스키마 커맨드는 Worker(`db/tables.js`)가 만들어 적용하므로
 * 여기서는 `schema.*` op를 부르고 그 결과의 커맨드를 스토어(저널·dirty)에 반영하는 얇은 래퍼만 둔다.
 * Step 5의 데이터 커맨드(셀 편집, 행 추가·삭제, 붙여넣기)가 이 파일에 더해진다.
 */

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../db/values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('../db/values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('../db/client.js').CallOptions} CallOptions */

/**
 * @typedef {object} SchemaCommands
 * @property {(input: { name: string }) => Promise<string | null>} createTable 만든 테이블 id
 * @property {(tableId: string, name: string) => Promise<boolean>} renameTable
 * @property {(tableId: string) => Promise<boolean>} dropTable 되돌릴 수 없음. 확인은 UI가 먼저 받는다
 * @property {(tableId: string, input: { name: string, type: LogicalType, options?: ColumnOptions | null }) => Promise<{ columnId: string, columnCount: number } | null>} addColumn
 * @property {(tableId: string, columnId: string, name: string) => Promise<boolean>} renameColumn
 * @property {(tableId: string, orderedIds: string[]) => Promise<boolean>} reorderColumns
 * @property {(tableId: string, columnId: string) => Promise<boolean>} softDeleteColumn
 * @property {(tableId: string, columnId: string) => Promise<boolean>} restoreColumn
 * @property {(tableId: string, columnId: string, input: { type: LogicalType, policy: CoercePolicy, options?: ColumnOptions | null }, options?: CallOptions) => Promise<{ columnId: string, nulled: number } | null>} changeColumnType
 */

/**
 * @param {Store} store
 * @returns {SchemaCommands}
 */
export function createSchemaCommands(store) {
  return {
    async createTable(input) {
      const result = await store.runSchemaOp('schema.create', { name: input.name });
      if (result) store.selectTable(result.tableId);
      return result ? result.tableId : null;
    },
    async renameTable(tableId, name) {
      return (await store.runSchemaOp('schema.rename', { tableId, name })) !== null;
    },
    async dropTable(tableId) {
      return (await store.runSchemaOp('schema.drop', { tableId })) !== null;
    },
    async addColumn(tableId, input) {
      const result = await store.runSchemaOp('schema.addColumn', {
        tableId,
        name: input.name,
        type: input.type,
        options: input.options ?? null,
      });
      return result ? { columnId: result.columnId, columnCount: result.columnCount } : null;
    },
    async renameColumn(tableId, columnId, name) {
      return (await store.runSchemaOp('schema.renameColumn', { tableId, columnId, name })) !== null;
    },
    async reorderColumns(tableId, orderedIds) {
      return (await store.runSchemaOp('schema.reorderColumns', { tableId, orderedIds })) !== null;
    },
    async softDeleteColumn(tableId, columnId) {
      return (await store.runSchemaOp('schema.softDeleteColumn', { tableId, columnId })) !== null;
    },
    async restoreColumn(tableId, columnId) {
      return (await store.runSchemaOp('schema.restoreColumn', { tableId, columnId })) !== null;
    },
    async changeColumnType(tableId, columnId, input, options) {
      const result = await store.runSchemaOp(
        'schema.changeColumnType',
        {
          tableId,
          columnId,
          type: input.type,
          policy: input.policy,
          options: input.options ?? null,
        },
        options,
      );
      return result ? { columnId: result.columnId, nulled: result.result.nulled ?? 0 } : null;
    },
  };
}
