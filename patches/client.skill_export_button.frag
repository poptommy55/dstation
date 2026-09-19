                          it.disk
                            ? h('button', { className: 'sp-icon', disabled: !canEdit, title: '导出为 .zip（可分享给他人）', onClick: function () { exportSkill(ctx, setS, patch, it.name); } }, '⬇')
                            : null,
