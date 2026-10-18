# strict-respond-3788

`shell-after-agy-exit.txt`: the pane after agy (1.4.1) exited, as `tmux capture-pane -p`
read it on 2026-10-18 (private socket `tmux -L`, private `HOME`, a folder agy had never
seen, 200x50). agy draws on the alternate screen and clears it on exit, so what is left
is the login shell's prompt line with the `agy` it ran. The user and host names are
replaced by `agy-user@host`; blank rows are dropped.

`#{pane_current_command}` of the same pane read `agy` while agy was up and `zsh` once it
had exited. The exit was measured through Ctrl-C at the sign-in screen, because the
private `HOME` holds no credentials (they were not copied), so the trust screen could not
be reached there. The #3773 UAT (real `HOME`) saw the same end state after `No, exit`: the
tmux session still up, the shell in the pane, the observation `running:true` / `kind:unknown`.
