from typing import Any, Protocol


class WorkflowAdapter(Protocol):
    """Integration boundary for future LangGraph workflows.

    Implementations should accept validated business context and return a
    structured proposal for human review. They must never send outreach or
    write business records directly.
    """

    async def propose(self, context: dict[str, Any]) -> dict[str, Any]: ...
