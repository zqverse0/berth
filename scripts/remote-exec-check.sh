#!/usr/bin/env bash
# 对照测试：同一条命令「直接 ssh 到设备 bash -c」与「berth remote exec」结果是否一致。
# 比较 stdout、stderr、退出码、最终目录。用法：
#   scripts/remote-exec-check.sh <ssh目标> <设备上的项目目录> <本机挂载点> [berth 路径]
set -u
target=$1 root=$2 mount=$3 berth=${4:-berth}
export BERTH_REMOTE_TARGET=$target BERTH_REMOTE_PATH=$root BERTH_REMOTE_MOUNT=$mount
cd "$mount" || exit 2
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
work=$(mktemp -d)
pass=0 fail=0

check() {
  local name=$1 cmd=$2
  # 基准：直接 ssh，设备登录 PATH + bash -c；EXIT trap（与命令同在第 1 行，行号不变）把目录
  # 写在 stderr 最后一行再剥离
  local trap_cwd="__t() { __s=\$?; printf '\\n@@CWD@@%s' \"\$(pwd -P)\" >&2; exit \$__s; }; trap __t EXIT; "
  ssh -o BatchMode=yes -- "$target" "cd -- $(q "$root") && export PATH=\$(\"\$SHELL\" -lc 'printf %s \"\$PATH\"' </dev/null 2>/dev/null) && bash -c $(q "$trap_cwd$cmd") </dev/null" >"$work/exp.out" 2>"$work/exp.err"
  local exp_code=$?
  local exp_cwd; exp_cwd=$(sed -n 's/^@@CWD@@//p' "$work/exp.err")
  sed -i -e '/^@@CWD@@/d' "$work/exp.err"; sed -i -e '${/^$/d}' "$work/exp.err"
  local exp_root; exp_root=$(ssh -o BatchMode=yes -- "$target" "cd -- $(q "$root") && pwd -P")
  # 被测：berth remote exec
  local cwdf; cwdf=$(mktemp)
  "$berth" remote exec --cwd-file "$cwdf" -- "$cmd" >"$work/got.out" 2>"$work/got.err" </dev/null
  local got_code=$?
  local got_cwd; got_cwd=$(cat "$cwdf"); rm -f "$cwdf"
  # 目录口径：都换算成相对项目根；离开项目根时 Berth 不回写（为空），基准记为 <outside>
  local exp_rel="<outside>"
  case "$exp_cwd" in "$exp_root"|"$exp_root"/*) exp_rel=${exp_cwd#"$exp_root"};; esac
  local got_rel="<outside>"
  [ -n "$got_cwd" ] && got_rel=${got_cwd#"$mount"}
  local bad=""
  cmp -s "$work/exp.out" "$work/got.out" || bad+=" stdout"
  cmp -s "$work/exp.err" "$work/got.err" || bad+=" stderr"
  [ "$exp_code" = "$got_code" ] || bad+=" exit($exp_code≠$got_code)"
  [ "$exp_rel" = "$got_rel" ] || bad+=" cwd($exp_rel≠$got_rel)"
  if [ -z "$bad" ]; then
    pass=$((pass + 1)); printf '  ✓ %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  ✗ %s —%s\n' "$name" "$bad"
    diff <(cat "$work/exp.out") <(cat "$work/got.out") | head -5 | sed 's/^/      out /'
    diff <(cat "$work/exp.err") <(cat "$work/got.err") | head -5 | sed 's/^/      err /'
  fi
}

echo "== 语法与引号"
check "单双引号与变量"        'x="it'"'"'s \"q\" $HOME"; echo "$x"'
check "bash 数组与 [[ ]]"      'a=(1 2 3); [[ ${#a[@]} -eq 3 ]] && echo "${a[*]}"'
check "heredoc"                $'cat <<EOF\nline $((1+2))\n  indented\nEOF'
check "反斜杠与特殊字符"       'printf "%s\n" "a\\b" "\$dollar" "\`tick\`" "!bang" "*star"'
check "中文与 emoji"           'echo "中文 ✓ 🚀"'
check "通配符"                 'ls -d */ 2>/dev/null; echo *.md'
check "多行命令与管道"         $'for i in 3 1 2; do echo $i; done | sort\necho done'
echo "== 退出码与错误"
check "退出码透传"             'exit 42'
check "命令不存在"             'definitely_not_a_command_xyz'
check "多行命令第 3 行出错"    $'echo a\necho b\nno_such_cmd_line3'
check "语法错误的行号"         $'echo a\nif then fi'
check "首行是注释"             $'# comment\necho after-comment'
check "set -e 中途失败"        'set -e; echo a; false; echo b'
check "stderr 与 stdout 交错"  'echo o1; echo e1 >&2; echo o2; echo e2 >&2'
check "无换行结尾"             'printf "no-newline"'
echo "== 目录"
check "cd 子目录"              'cd sub && pwd'
check "cd 后 exit"             'cd sub; exit 3'
check "cd 到项目外"            'cd /tmp && pwd'
check "相对路径读文件"         'cat README.md | head -2'
echo "== 环境与输入"
check "登录 PATH"              'command -v python3; command -v git'
check "读 stdin 不挂起"        'cat; echo after'
check "大输出（2 万行）"       'seq 1 20000 | tail -3; seq 1 20000 | wc -l'
check "二进制输出"             'printf "\x00\x01\xff" | od -An -tx1'

echo "== 结果：$pass 通过，$fail 不一致"
rm -rf "$work"
[ "$fail" -eq 0 ]
