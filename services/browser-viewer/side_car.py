# agent_sidecar_311/side_car.py
import asyncio
import subprocess
from typing import Optional

class SocatManager:
    """
    Minimal SocatManager that starts/stops a socat process inside
    the current container to forward traffic from local port -> target host/port.
    """

    def __init__(
        self,
        listen_port: int = 5900,
        forward_host: str = "some_container_or_host",
        forward_port: int = 5900
    ):
        """
        :param listen_port: The local port on which socat should listen.
        :param forward_host: The hostname or IP where socat should forward connections.
        :param forward_port: The target port to forward to on the target host.
        """
        self.listen_port = listen_port
        self.forward_host = forward_host
        self.forward_port = forward_port
        # Will store the subprocess handle so we can stop it later.
        self.process: Optional[asyncio.subprocess.Process] = None

    async def start_socat(self) -> dict:
        """
        Starts socat locally (inside the container).
        This will forward local port self.listen_port -> self.forward_host:self.forward_port
        """
        # If a process is already running, return early.
        if self.process and self.process.returncode is None:
            return {"status": "already_running"}

        # Build the socat command. 
        # Note: 
        #  - 'fork' allows multiple connections.
        #  - 'reuseaddr' allows fast restarts.
        # If you want to listen on all interfaces inside the container, prefix with '0.0.0.0:' 
        # (e.g., `tcp-listen:5900,fork,reuseaddr`)
        cmd = [
            "socat",
            f"tcp-listen:{self.listen_port},fork,reuseaddr",
            f"tcp-connect:{self.forward_host}:{self.forward_port}"
        ]

        try:
            # Launch socat as an asyncio subprocess (detached).
            self.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            return {"status": "started"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    async def stop_socat(self) -> dict:
        """
        Stops the running socat process (if any).
        """
        if not self.process or self.process.returncode is not None:
            return {"status": "not_running"}

        # Gracefully terminate socat.
        self.process.terminate()
        try:
            # Give socat up to 5 seconds to exit before killing.
            await asyncio.wait_for(self.process.communicate(), timeout=5)
        except asyncio.TimeoutError:
            self.process.kill()

        # Reset process handle
        self.process = None
        return {"status": "stopped"}

    async def get_status(self) -> dict:
        """
        Returns whether socat is running or not.
        """
        if not self.process:
            return {"status": "stopped"}
        if self.process.returncode is None:
            return {"status": "running"}
        return {"status": "exited", "returncode": self.process.returncode}
