<script lang="ts">
import { m } from "@ceraui/i18n/svelte";
import type { ButtonOutput } from "@ceraui/rpc/schemas";
import { onDestroy } from "svelte";
import { Button } from "$lib/components/ui/button";
import { rpc } from "$lib/rpc/client";
import { setAuthStatus } from "$lib/stores/auth-status.svelte";
import { ButtonConfirm } from "./button-confirm";

let { purpose = "connect" }: { purpose?: "connect" | "disconnect" } = $props();
let output = $state<ButtonOutput>();
let starting = $state(false);
let remaining = $state(60);
let countdown: ReturnType<typeof setInterval> | undefined;
const flow = new ButtonConfirm(
 (input) => rpc.auth.button(input),
 (value) => {
  if (value.state === "waiting" && output?.state !== "waiting") {
   const deadline = Date.now() + 60_000;
   countdown = setInterval(() => {
    remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
   }, 250);
  }
  output = value;
  if (value.state !== "waiting") clearInterval(countdown);
 },
 (token) => {
  localStorage.setItem("auth", token);
  setAuthStatus(true);
 },
);
async function begin() {
 starting = true;
 output = undefined;
 remaining = 60;
 await flow.begin(purpose);
 starting = false;
}
function cancel() {
 flow.cancel();
 clearInterval(countdown);
 output = undefined;
}
onDestroy(cancel);
</script>

<div class="mt-4 space-y-3">
 {#if purpose === "disconnect"}
  <p class="text-muted-foreground text-sm">{m["auth.buttonDisconnectDetails"]()}</p>
 {/if}
 {#if output?.state === "waiting"}
  <div role="status" class="space-y-2">
   <p>{m["auth.buttonPrompt"]()}</p>
   <p>{m["auth.buttonMinute"]()}</p>
   <p>{m["auth.buttonCountdown"]({ seconds: remaining })}</p>
  </div>
  <Button variant="outline" onclick={cancel}>{m["auth.buttonCancel"]()}</Button>
 {:else}
  <Button variant="outline" disabled={starting} onclick={begin}>
   {purpose === "connect" ? m["auth.buttonConnect"]() : m["auth.buttonDisconnect"]()}
  </Button>
  {#if output}
   <p role="status" class="text-muted-foreground text-sm">
    {#if output.state === "stop-first"}{m["auth.buttonStopFirst"]()}
    {:else if output.state === "local-only"}{m["auth.buttonLocalOnly"]()}
    {:else if output.state === "timeout"}{m["auth.buttonTimeout"]()}
    {:else if output.state === "confirmed"}{m["auth.buttonDone"]()}
    {:else}{m["auth.buttonFallback"]()}{/if}
   </p>
  {/if}
 {/if}
</div>
