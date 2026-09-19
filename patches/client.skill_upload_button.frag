                      h('button', { className: 'sp-btn', style: { flex: '0 0 auto', padding: '6px 12px', fontSize: '12px' },
                        disabled: !canEdit, title: canEdit ? '上传技能包（.zip）或单个 .md/.json/.yaml 等文件' : '需要技能库文件通道（重启一次 D-STATION）',
                        onClick: function () { openImportPicker(ctx, setS, patch); } }, '⬆ 上传技能'))
