FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /app/ccf /app/audit /app/playbooks
COPY ccf/ /app/ccf/
COPY playbooks/ /app/playbooks/
COPY main.py .
CMD ["python", "-u", "main.py"]
